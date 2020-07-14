import * as _ from 'lodash';
import * as net from 'net';
import * as tls from 'tls';
import * as streams from 'stream';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as semver from 'semver';

import { getLocal } from "../..";
import { expect, nodeOnly, delay } from "../test-utils";

type Http2ResponseHeaders = http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;

function getResponse(req: http2.ClientHttp2Stream) {
    return new Promise<Http2ResponseHeaders>((resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
    });
}

function getBody(req: http2.ClientHttp2Stream) {
    return new Promise<Buffer>((resolve, reject) => {
        const body: Buffer[] = [];
        req.on('data', (d: Buffer | string) => {
            body.push(Buffer.from(d));
        });
        req.on('end', () => req.close());
        req.on('close', () => resolve(Buffer.concat(body)));
        req.on('error', reject);
    });
}

async function cleanup(...streams: (streams.Duplex | http2.Http2Session | http2.Http2Stream)[]) {
    for (let stream of streams) {
        stream.destroy();
    }
}

nodeOnly(() => {
    describe("Using Mockttp with HTTP/2", function () {

        describe("without TLS", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                await server.get('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2c'); // Plaintext HTTP/2

                const responseBody = await getBody(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");

                await cleanup(client);
            });

            it("can respond to proxied HTTP/2 requests", async () => {
                await server.get('http://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': 'example.com:80'
                });

                // Initial response, the proxy has set up our tunnel:
                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                // We can now read/write to req as a raw TCP socket to example.com:
                const proxiedClient = http2.connect('http://example.com', {
                     // Tunnel this request through the proxy stream
                    createConnection: () => req
                });

                const proxiedRequest = proxiedClient.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getResponse(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getBody(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(proxiedClient, client);
            });

            it("can respond to HTTP1-proxied HTTP/2 requests", async () => {
                await server.get('http://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                // Get an HTTP/1.1 tunnel:
                const req = http.request({
                    method: 'CONNECT',
                    host: 'localhost',
                    port: server.port,
                    path: 'example.com'
                });
                req.end();

                const tunnelledSocket = await new Promise<net.Socket>((resolve) => {
                    req.on('connect', (_res, socket) => resolve(socket));
                });

                // We can now read/write to our raw TCP socket to example.com:
                const client = http2.connect('http://example.com', {
                    // Tunnel this request through the HTTP/1.1 tunnel:
                    createConnection: () => tunnelledSocket
                });

                const proxiedRequest = client.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getResponse(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getBody(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(client, tunnelledSocket);
            });

            describe("with a remote server", () => {
                const remoteServer = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });

                beforeEach(() => remoteServer.start());
                afterEach(() => remoteServer.stop());

                it("can forward requests upstream", async () => {
                    await remoteServer.get('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!");
                    await server.get(remoteServer.urlFor('/mocked-endpoint'))
                        .thenPassThrough();

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remoteServer.port}`
                    });

                    // Initial response, so the proxy has set up our tunnel:
                    const responseHeaders = await getResponse(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to remoteServer:
                    const proxiedClient = http2.connect(remoteServer.url, {
                        // Tunnel this request through the proxy stream
                        createConnection: () => req
                    });

                    const proxiedRequest = proxiedClient.request({
                        ':path': '/mocked-endpoint'
                    });
                    const proxiedResponse = await getResponse(proxiedRequest);
                    expect(proxiedResponse[':status']).to.equal(200);

                    const responseBody = await getBody(proxiedRequest);
                    expect(responseBody.toString('utf8')).to.equal("Remote HTTP2 response!");

                    await cleanup(proxiedClient, client);
                });

                it("reformats forwarded request headers for HTTP/1.1", async () => {
                    const mockedEndpoint = await remoteServer.get('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!");
                    await server.get(remoteServer.urlFor('/mocked-endpoint'))
                        .thenPassThrough();

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remoteServer.port}`
                    });

                    // Initial response, so the proxy has set up our tunnel:
                    const responseHeaders = await getResponse(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to remoteServer:
                    const proxiedClient = http2.connect(remoteServer.url, {
                        // Tunnel this request through the proxy stream
                        createConnection: () => req
                    });

                    await getResponse(proxiedClient.request({
                        ':path': '/mocked-endpoint',
                        'Cookie': 'a=b',
                        'cookie': 'b=c'
                    }));

                    const seenRequests = await mockedEndpoint.getSeenRequests();
                    expect(seenRequests.length).to.equal(1);

                    expect(seenRequests[0].headers).to.deep.equal({
                        'host': `localhost:${remoteServer.port}`, // Host replaces :authority
                        'connection': 'keep-alive', // We add this for upstream, as all H2 are keep-alive
                        'cookie': 'a=b; b=c' // Concatenated automatically
                    });

                    await cleanup(proxiedClient, client);
                });

                it("reformats forwarded response headers for HTTP/1.1", async () => {
                    await remoteServer.get('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!", {
                            'HEADER-KEY': 'HEADER-VALUE',
                            'Connection': 'close'
                        });
                    await server.get(remoteServer.urlFor('/mocked-endpoint'))
                        .thenPassThrough();

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remoteServer.port}`
                    });

                    // Initial response, so the proxy has set up our tunnel:
                    const responseHeaders = await getResponse(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to remoteServer:
                    const proxiedClient = http2.connect(remoteServer.url, {
                        // Tunnel this request through the proxy stream
                        createConnection: () => req
                    });

                    const proxiedResponseHeaders = await getResponse(
                        proxiedClient.request({
                            ':path': '/mocked-endpoint',
                        })
                    );

                    expect(_.omit(proxiedResponseHeaders, 'date')).to.deep.equal({
                        ':status': 200,
                        'header-key': 'HEADER-VALUE' // We lowercase all header keys
                        // Connection: close is omitted
                    });

                    await cleanup(proxiedClient, client);
                });
            });

        });

        describe("with TLS", () => {

            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                server.get('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2'); // HTTP/2 over TLS

                const responseBody = await getBody(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");

                await cleanup(client);
            });

            it("can respond to proxied HTTP/2 requests", async function() {
                if (!semver.satisfies(process.version, '>=12')) {
                    // Due to a bug in Node 10 (from 10.16.3+), TLS sockets on top of
                    // TLS sockets don't work. Mockttp works fine, it's just that
                    // the tests fail to complete the TLS client connection.
                    this.skip();
                }

                await server.get('https://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': 'example.com:443'
                });

                // Initial response, the proxy has set up our tunnel:
                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                // We can now read/write to req as a raw TCP socket to example.com:
                const proxiedClient = http2.connect('https://example.com', {
                     // Tunnel this request through the proxy stream
                    createConnection: () => tls.connect({
                        socket: req as any,
                        ALPNProtocols: ['h2']
                    })
                });

                const proxiedRequest = proxiedClient.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getResponse(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getBody(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(proxiedClient, client);
            });

            it("can respond to HTTP1-proxied HTTP/2 requests", async function() {
                if (!semver.satisfies(process.version, '>=12')) {
                    // Due to a bug in Node 10 (from 10.16.3+), TLS sockets on top of
                    // TLS sockets don't work. Mockttp works fine, it's just that
                    // the tests fail to complete the TLS client connection.
                    this.skip();
                }

                await server.get('https://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                // Get an HTTP/1.1 tunnel:
                const req = https.request({
                    method: 'CONNECT',
                    host: 'localhost',
                    port: server.port,
                    path: 'example.com'
                });
                req.end();

                const tunnelledSocket = await new Promise<net.Socket>((resolve) => {
                    req.on('connect', (_res, socket) => resolve(socket));
                });

                // We can now read/write to our raw TCP socket to example.com:
                const client = http2.connect('https://example.com', {
                    // Tunnel this request through the HTTP/1.1 tunnel, via TLS:
                    createConnection: () => tls.connect({
                        socket: tunnelledSocket,
                        ALPNProtocols: ['h2']
                    })
                });

                const proxiedRequest = client.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getResponse(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getBody(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(tunnelledSocket, client);
            });

        });

    });
});