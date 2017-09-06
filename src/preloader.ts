import { traceObservable } from "./tracing";
import { Span } from "opentracing/lib";
import { Observable } from "@reactivex/rxjs/dist/cjs/Rx";

export interface Preloader {
	ensureModuleStructure(childOf?: Span): Observable<never>;
	ensureOwnFiles(childOf: Span): Observable<never>;
	ensureAllFiles(childOf: Span): Observable<never>;


}

export class RealPreloader implements Preloader {
	/**
	 * Ensures that the module structure of the project exists in memory.
	 * TypeScript/JavaScript module structure is determined by [jt]sconfig.json,
	 * filesystem layout, global*.d.ts and package.json files.
	 * Then creates new ProjectConfigurations, resets existing and invalidates file references.
	 */
	ensureModuleStructure(childOf = new Span()): Observable<never> {
		return traceObservable('Ensure module structure', childOf, span => {
			return this.updater.ensureStructure()
				// Ensure content of all all global .d.ts, [tj]sconfig.json, package.json files
				.concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
				.filter(uri => isGlobalTSFile(uri) || isConfigFile(uri) || isPackageJsonFile(uri))
				.mergeMap(uri => this.updater.ensure(uri))
				.do(noop, err => {
					return undefined;
				}, () => {

					// TOM TODO MOVE TO PROJECTMANAGER.TS

					// Reset all compilation state
					// TODO ze incremental compilation instead
					for (const config of this.configurations()) {
						config.reset();
					}
					// Require re-processing of file references
					this.invalidateReferencedFiles();
				})
				.publishReplay()
				.refCount();
		});
	}

	ensureOwnFiles(childOf = new Span()): Observable<never> {
		this.updater.ensureStructure(span)
			.concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
			.filter(uri => !uri.includes('/node_modules/') && isJSTSFile(uri) || isConfigFile(uri) || isPackageJsonFile(uri))
			.mergeMap(uri => this.updater.ensure(uri))
			.do(noop, err => {
				this.ensuredOwnFiles = undefined;
			})
			.publishReplay()
			.refCount();
	}

		/**
	 * Ensures all files were fetched from the remote file system.
	 * Invalidates project configurations after execution
	 */
	ensureAllFiles(childOf = new Span()): Observable<never> {
		return traceObservable('Ensure all files', childOf, span => {
			return this.updater.ensureStructure(span)
				.concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
				.filter(uri => isJSTSFile(uri) || isConfigFile(uri) || isPackageJsonFile(uri))
				.mergeMap(uri => this.updater.ensure(uri))
				.do(noop, err => {
					this.ensuredAllFiles = undefined;
				})
				.publishReplay()
				.refCount();
		});
	}

	/*
	 * Recursively collects file(s) dependencies up to given level.
	 * Dependencies are extracted by TS compiler from import and reference statements
	 *
	 * Dependencies include:
	 * - all the configuration files
	 * - files referenced by the given file
	 * - files included by the given file
	 *
	 * The return values of this method are not cached, but those of the file fetching and file processing are.
	 *
	 * @param uri File to process
	 * @param maxDepth Stop collecting when reached given recursion level
	 * @param ignore Tracks visited files to prevent cycles
	 * @param childOf OpenTracing parent span for tracing
	 * @return Observable of file URIs ensured
	 */
	ensureReferencedFiles(uri: string, maxDepth = 30, ignore = new Set<string>(), childOf = new Span()): Observable<string> {
		return traceObservable('Ensure referenced files', childOf, span => {
			span.addTags({ uri, maxDepth });
			ignore.add(uri);
			return this.ensureModuleStructure(span)
				// If max depth was reached, don't go any further
				.concat(Observable.defer(() => maxDepth === 0 ? Observable.empty<never>() : this.resolveReferencedFiles(uri)))
				// Prevent cycles
				.filter(referencedUri => !ignore.has(referencedUri))
				// Call method recursively with one less dep level
				.mergeMap(referencedUri =>
					this.ensureReferencedFiles(referencedUri, maxDepth - 1, ignore)
						// Continue even if an import wasn't found
						.catch(err => {
							this.logger.error(`Error resolving file references for ${uri}:`, err);
							return [];
						})
				);
		});
	}

	/**
	 * Returns the files that are referenced from a given file.
	 * If the file has already been processed, returns a cached value.
	 *
	 * @param uri URI of the file to process
	 * @return URIs of files referenced by the file
	 */
	private resolveReferencedFiles(uri: string, span = new Span()): Observable<string> {
		let observable = this.referencedFiles.get(uri);
		if (observable) {
			return observable;
		}
		observable = this.updater.ensure(uri)
			.concat(Observable.defer(() => {
				const referencingFilePath = uri2path(uri);
				const config = this.getConfiguration(referencingFilePath);
				config.ensureBasicFiles(span);
				const contents = this.inMemoryFs.getContent(uri);
				const info = ts.preProcessFile(contents, true, true);
				const compilerOpt = config.getHost().getCompilationSettings();
				const pathResolver = referencingFilePath.includes('\\') ? path.win32 : path.posix;
				// Iterate imported files
				return Observable.merge(
					// References with `import`
					Observable.from(info.importedFiles)
						.map(importedFile => ts.resolveModuleName(importedFile.fileName, toUnixPath(referencingFilePath), compilerOpt, this.inMemoryFs))
						// false means we didn't find a file defining the module. It could still
						// exist as an ambient module, which is why we fetch global*.d.ts files.
						.filter(resolved => !!(resolved && resolved.resolvedModule))
						.map(resolved => resolved.resolvedModule!.resolvedFileName),
					// References with `<reference path="..."/>`
					Observable.from(info.referencedFiles)
						// Resolve triple slash references relative to current file instead of using
						// module resolution host because it behaves differently in "nodejs" mode
						.map(referencedFile => pathResolver.resolve(this.rootPath, pathResolver.dirname(referencingFilePath), toUnixPath(referencedFile.fileName))),
					// References with `<reference types="..."/>`
					Observable.from(info.typeReferenceDirectives)
						.map(typeReferenceDirective => ts.resolveTypeReferenceDirective(typeReferenceDirective.fileName, referencingFilePath, compilerOpt, this.inMemoryFs))
						.filter(resolved => !!(resolved && resolved.resolvedTypeReferenceDirective && resolved.resolvedTypeReferenceDirective.resolvedFileName))
						.map(resolved => resolved.resolvedTypeReferenceDirective!.resolvedFileName!)
				);
			}))
			// Use same scheme, slashes, host for referenced URI as input file
			.map(filePath => path2uri(filePath))
			// Don't cache errors
			.do(noop, err => {
				this.referencedFiles.delete(uri);
			})
			// Make sure all subscribers get the same values
			.publishReplay()
			.refCount();
		this.referencedFiles.set(uri, observable);
		return observable;
	}

}

export class NotPreloader {

}