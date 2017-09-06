import { noop } from 'lodash'
import { Span } from 'opentracing/lib'
import * as path from 'path'
import { Observable } from 'rxjs'
import * as ts from 'typescript'
import { FileSystemUpdater } from './fs'
import { Logger, NoopLogger } from './logging'
import { InMemoryFileSystem } from './memfs'
import { ProjectConfiguration } from './project-manager'
import { traceObservable } from './tracing'
import { isConfigFile, isDependencyFile, isGlobalTSFile, isJSTSFile, isPackageJsonFile, observableFromIterable, path2uri, toUnixPath, uri2path } from './util'

export interface Preloader {
    ensureModuleStructure(childOf?: Span): Observable<never>
    ensureConfigDependencies(childOf?: Span): Observable<never>
    ensureOwnFiles(childOf: Span): Observable<never>
    ensureAllFiles(span?: Span): void
    ensureReferencedFiles(uri: string, maxDepth: number, ignore: Set<string>, childOf: Span | undefined): Observable<string>
}

export class NoPreloader implements Preloader {

    private ensuredModuleStructure?: Observable<never>

    constructor(
        private inMemoryFileSystem: InMemoryFileSystem,
        private updater: FileSystemUpdater,
        protected logger: Logger = new NoopLogger()
    ) {
    }

    public ensureModuleStructure(childOf?: Span): Observable<never> {
        this.logger.warn('ensureModuleStructure')
        if (this.ensuredModuleStructure) {
            return this.ensuredModuleStructure
        }
        // Why are we still preloading?
        // in-memory filesystem provides no recursive local-disk-based getFileSystemEntries (yet)
        // project manager listens for file system events to replace default TS configs.
        // Also, we added isDependencyFile to the filter.
        const ensuredStructure = this.updater.ensureStructure()
        const loadTSConfigs = observableFromIterable(this.inMemoryFileSystem.uris())
            .filter(file => isConfigFile(file) && !isDependencyFile(file))
            .do(uri => this.logger.warn('loading', uri))
            .mergeMap(uri => this.updater.ensure(uri))

        this.ensuredModuleStructure = ensuredStructure
            .concat(loadTSConfigs)
            .publishReplay()
            .refCount()

        return this.ensuredModuleStructure
    }

    public ensureConfigDependencies(childOf?: Span): Observable<never> {
        this.logger.warn('ensureConfigDependencies')
        return Observable.of()
    }

    public ensureOwnFiles(childOf: Span): Observable<never> {
        this.logger.warn('ensureOwnFiles')
        return this.ensureModuleStructure(childOf)
    }
    public ensureAllFiles(childOf: Span): Observable<never> {
        this.logger.warn('ensureAllFiles')
        return Observable.of()
    }
    public ensureReferencedFiles(uri: string, maxDepth: number, ignore: Set<string>, childOf: Span): Observable<string> {
        this.logger.warn('ensureReferencedFiles')
        // this needs to complete when ensureOwnFiles has completed so didOpen doesn't call getProgram before TSconfigs are in place.
        return this.ensureOwnFiles(childOf)
    }

}

export class RealPreloader implements Preloader {

    /**
     * Root path with slashes
     */
    private rootPath: string

    /**
     * File system updater that takes care of updating the in-memory file system
     */
    private updater: FileSystemUpdater

    /**
     * Local side of file content provider which keeps cache of fetched files
     */
    private inMemoryFs: InMemoryFileSystem

    /**
     * Flag indicating that we fetched module struture (tsconfig.json, jsconfig.json, package.json files) from the remote file system.
     * Without having this information we won't be able to split workspace to sub-projects
     */
    private ensuredModuleStructure?: Observable<never>

    /**
     * Observable that completes when extra dependencies pointed to by tsconfig.json have been loaded.
     */
    private ensuredConfigDependencies?: Observable<never>

    /**
     * Observable that completes when `ensureAllFiles` completed
     */
    private ensuredAllFiles = false // ?: boolean

    /**
     * Observable that completes when `ensureOwnFiles` completed
     */
    private ensuredOwnFiles?: Observable<never>

    /**
     * A URI Map from file to files referenced by the file, so files only need to be pre-processed once
     */
    private referencedFiles = new Map<string, Observable<string>>()

    /**
     * @param rootPath root path as passed to `initialize`
     * @param inMemoryFileSystem File system that keeps structure and contents in memory
     * @param strict indicates if we are working in strict mode (VFS) or with a local file system
     * @param traceModuleResolution allows to enable module resolution tracing (done by TS compiler)
     */
    constructor(
        rootPath: string,
        inMemoryFileSystem: InMemoryFileSystem,
        updater: FileSystemUpdater,
        private getConfiguration: (uri: string) => ProjectConfiguration,
        protected logger: Logger = new NoopLogger()
    ) {
        this.rootPath = rootPath
        this.updater = updater
        this.inMemoryFs = inMemoryFileSystem
    }
    /**
     * Ensures that the module structure of the project exists in memory.
     * TypeScript/JavaScript module structure is determined by [jt]sconfig.json,
     * filesystem layout, global*.d.ts and package.json files.
     * Then creates new ProjectConfigurations, resets existing and invalidates file references.
     */
    public ensureModuleStructure(childOf = new Span()): Observable<never> {
        return traceObservable('Ensure module structure', childOf, span => {
            if (!this.ensuredModuleStructure) {
                this.ensuredModuleStructure = this.updater.ensureStructure()
                    // Ensure content of all all global .d.ts, [tj]sconfig.json, package.json files
                    .concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
                    .filter(uri => isGlobalTSFile(uri) || isConfigFile(uri) || isPackageJsonFile(uri))
                    .mergeMap(uri => this.updater.ensure(uri))
                    .do(noop, err => {
                        this.ensuredModuleStructure = undefined
                    }, () => {

                        // I BROKE THIS - this causes configs and references to be reset when module structure is invalidated.

                        // Reset all compilation state
                        // TODO ze incremental compilation instead
                        // for (const config of this.configurations()) {
                        //     config.reset()
                        // }
                        // Require re-processing of file references
                        // this.invalidateReferencedFiles()
                    })
                    .publishReplay()
                    .refCount() as Observable<never>
            }
            return this.ensuredModuleStructure
        })
    }

    /**
     * Determines if a tsconfig/jsconfig needs additional declaration files loaded.
     * @param filePath A UNIX-like absolute file path
     */
    public isConfigDependency(filePath: string): boolean {
        // TODO: fix
        // for (const config of this.configurations()) {
        //     config.ensureConfigFile()
        //     if (config.isExpectedDeclarationFile(filePath)) {
        //         return true
        //     }
        // }
        return false
    }

    public ensureConfigDependencies(childOf = new Span()): Observable<never> {
        return traceObservable('Ensure config dependencies', childOf, span => {
            if (!this.ensuredConfigDependencies) {
                this.ensuredConfigDependencies = observableFromIterable(this.inMemoryFs.uris())
                .filter(uri => this.isConfigDependency(toUnixPath(uri2path(uri))))
                .mergeMap(uri => this.updater.ensure(uri))
                .do(noop, err => {
                    this.ensuredConfigDependencies = undefined
                })
                .publishReplay()
                .refCount() as Observable<never>
            }
            return this.ensuredConfigDependencies
        })
    }

    public ensureOwnFiles(childOf = new Span()): Observable<never> {
        return traceObservable('Ensure own files', childOf, span => {
            if (!this.ensuredOwnFiles) {
                this.ensuredOwnFiles = this.updater.ensureStructure(span)
                    .concat(Observable.defer(() => observableFromIterable(this.inMemoryFs.uris())))
                    .filter(uri => !uri.includes('/node_modules/') && isJSTSFile(uri) || isConfigFile(uri) || isPackageJsonFile(uri))
                    .mergeMap(uri => this.updater.ensure(uri))
                    .do(noop, err => {
                        this.ensuredOwnFiles = undefined
                    })
                    .publishReplay()
                    .refCount() as Observable<never>
            }
            return this.ensuredOwnFiles
        })
    }

    /**
     * Ensures all files were fetched from the remote file system.
     * Invalidates project configurations after execution
     */
    public ensureAllFiles(span = new Span()): void {
        // TODO fix.
        // if (this.ensuredAllFiles) {
        //     return
        // }
        // this.init(span)
        // if (this.getHost().complete) {
        //     return
        // }
        // const program = this.getProgram(span)
        // if (!program) {
        //     return
        // }
        // for (const fileName of this.expectedFilePaths) {
        //     const sourceFile = program.getSourceFile(fileName)
        //     if (!sourceFile) {
        //         this.getHost().addFile(fileName)
        //     }
        // }
        // this.getHost().complete = true
        // this.ensuredAllFiles = true
    }

    /**
     * Invalidates caches for `ensureModuleStructure`, `ensureAllFiles` and `insureOwnFiles`
     */
    public invalidateModuleStructure(): void {
        this.ensuredModuleStructure = undefined
        this.ensuredAllFiles = undefined
        this.ensuredOwnFiles = undefined
    }

    /**
     * Invalidates a cache entry for `resolveReferencedFiles` (e.g. because the file changed)
     *
     * @param uri The URI that referenced files should be invalidated for. If not given, all entries are invalidated
     */
    public invalidateReferencedFiles(uri?: string): void {
        if (uri) {
            this.referencedFiles.delete(uri)
        } else {
            this.referencedFiles.clear()
        }
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
    public ensureReferencedFiles(uri: string, maxDepth = 30, ignore = new Set<string>(), childOf = new Span()): Observable<string> {
        return traceObservable('Ensure referenced files', childOf, span => {
            span.addTags({ uri, maxDepth })
            ignore.add(uri)
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
                            this.logger.error(`Error resolving file references for ${uri}:`, err)
                            return []
                        })
                )
        })
    }

    /**
     * Returns the files that are referenced from a given file.
     * If the file has already been processed, returns a cached value.
     *
     * @param uri URI of the file to process
     * @return URIs of files referenced by the file
     */
    private resolveReferencedFiles(uri: string, span = new Span()): Observable<string> {
        let observable = this.referencedFiles.get(uri)
        if (observable) {
            return observable
        }
        observable = this.updater.ensure(uri)
            .concat(Observable.defer(() => {
                const referencingFilePath = uri2path(uri)
                const config = this.getConfiguration(referencingFilePath)
                config.ensureBasicFiles(span)
                const contents = this.inMemoryFs.getContent(uri)
                const info = ts.preProcessFile(contents, true, true)
                const compilerOpt = config.getHost().getCompilationSettings()
                const pathResolver = referencingFilePath.includes('\\') ? path.win32 : path.posix
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
                )
            }))
            // Use same scheme, slashes, host for referenced URI as input file
            .map(path2uri)
            // Don't cache errors
            .do(noop, err => {
                this.referencedFiles.delete(uri)
            })
            // Make sure all subscribers get the same values
            .publishReplay()
            .refCount()
        this.referencedFiles.set(uri, observable)
        return observable
    }
}
