import * as chai from 'chai';
import * as sinon from 'sinon';
import glob = require('glob');
const path = require('path');
import { LanguageClient, RemoteLanguageClient } from '../lang-handler';
import { TypeScriptService } from '../typescript-service';
import { path2uri } from '../util';
import chaiAsPromised = require('chai-as-promised');
// import jsonpatch from 'fast-json-patch';
import { LocalFileSystem } from '../fs';
chai.use(chaiAsPromised);
const assert = chai.assert;

describe('running against angular', () => {
	let client: { [K in keyof LanguageClient]: LanguageClient[K] & sinon.SinonStub };
	let service: TypeScriptService;
	let rootUri: string;

	const rootPath = path.resolve(process.cwd(), '../../angular/angular');
	// const filePath = 'aio/aio-builds-setup/dockerbuild/scripts-js/test/clean-up/build-cleaner.spec.ts';
	// at #L63:54
	// const filePaths = glob.sync('src/*.ts');
	// const fs = new LocalFileSystem(rootPath);

	before(async () => {
		client = sinon.createStubInstance(RemoteLanguageClient);

		rootUri = path2uri(rootPath) + '/';

		service = new TypeScriptService(client, {strict: false, traceModuleResolution: false});
		await service.initialize({
			processId: process.pid,
			rootUri,
			capabilities: {}
		}).toPromise();
	});

	// it('should get no diagnostics on didOpen ' + filePath, async () => {
	// 	const fileUri = path2uri(rootPath + '/' + filePath);
	// 	const fileContent = await fs.getTextDocumentContent(fileUri);

	// 	assert.isAtLeast(fileContent.length, 1);
	// 	client.textDocumentPublishDiagnostics.resetHistory();

	// 	const result = await service.textDocumentHover({
	// 		textDocument: {
	// 			uri: fileUri
	// 		},
	// 		position: {
	// 			character: 10,
	// 			line: 62
	// 		}
	// 	}).reduce<jsonpatch.Operation, Location[]>(jsonpatch.applyReducer, null as any).toPromise();
	// 	assert.deepEqual(result, {
	// 		contents: [{
	// 			language: 'typescript',
	// 			value: 'function expect(spy: Function): jasmine.Matchers<any> (+2 overloads)'
	// 		},
	// 		'**function** _(ambient)_',
	// 		'Create an expectation for a spec.'
	// 	],
	// 	range: {
	// 		start: { line: 62, character: 6 },
	// 		end: { line: 62, character: 12 } }
	// 	});
	// });
});

describe('running against this project', () => {
	let client: { [K in keyof LanguageClient]: LanguageClient[K] & sinon.SinonStub };
	let service: any;
	let rootUri: string;

	const rootPath = process.cwd();
	const filePaths = glob.sync('src/*.ts');
	const fs = new LocalFileSystem(rootPath);

	before(async () => {
		client = sinon.createStubInstance(RemoteLanguageClient);

		rootUri = path2uri(rootPath) + '/';

		service = new TypeScriptService(client, {strict: false, traceModuleResolution: false});
		await service.initialize({
			processId: process.pid,
			rootUri,
			capabilities: {}
		}).toPromise();
	});

	for (const filePath of filePaths) {
		it('should get no diagnostics on didOpen ' + filePath, async () => {
			const fileUri = path2uri(rootPath + '/' + filePath);
			const fileContent = await fs.getTextDocumentContent(fileUri).toPromise();

			assert.isAtLeast(fileContent.length, 1);
			client.textDocumentPublishDiagnostics.resetHistory();

			await service.textDocumentDidOpen({
				textDocument: {
					uri: fileUri,
					languageId: 'typescript',
					version: 1,
					text: fileContent
				}
			});
			sinon.assert.calledWithExactly(client.textDocumentPublishDiagnostics,
			{
				diagnostics: [],
				uri: fileUri
			});

			const resp = await service.textDocumentDidClose({
				textDocument: {
					uri: fileUri
				}
			});
			return resp;
		});
	}
});
