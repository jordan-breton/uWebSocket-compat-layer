/**
 * @implements {IRequestSender}
 */
class Sender {
	_requestBuffer;
	_sendingStrategy;

	constructor(sendingStrategy){
		this._requestBuffer = new Map();
		this._sendingStrategy = sendingStrategy;
	}

	acceptsMoreRequests(){
		return this._sendingStrategy.acceptsMoreRequests();
	}

	close(){
		this._sendingStrategy.close();
	}

	_send(socket, request) {
		const rawHeaders = `${request.method.toUpperCase()} ${request.path} HTTP/1.1\r\n`
			+ `host: ${request.host}:${request.port}\r\n`
			+ `connection: keep-alive\r\n`
			+ Object.keys(request.headers).map(key => `${key}: ${request.headers[key]}`).join('\r\n')
			+ '\r\n\r\n';

		let sent = socket.write(rawHeaders, 'utf8');
		if(!sent){
			// we have backpressure
			this._requestBuffer.set(request, true);

			socket.once('drain', () => {
				this._requestBuffer.delete(request);
				this._stream(socket, request);
			});
		} else {
			// we can start to send the body
			this._stream(socket, request);
		}
	}

	send(socket, request, callback) {
		if(!request.path) request.path = '/';
		if(!request.method) request.method = 'GET';
		if(!request.headers) request.headers = {};

		this._sendingStrategy.scheduleSend(
			request,
			callback,
			() => this._send(socket, request)
		);
	}

	_trySendChunk(socket, context, chunk){
		if(!context.backpressure){
			let sent = socket.write(chunk);
			if(!sent){
				context.backpressure = true;
				socket.once('drain', () => {
					context.written += chunk.byteLength;
					context.backpressure = false;

					this._trySendChunk(socket, context, context.stackedBuffers.shift());
				});
			}else {
				context.written += chunk.byteLength;
			}

			return sent;
		}else{
			context.stackedBuffers.push(chunk);
		}

		return false;
	}

	_stream(socket, request){
		const { headers, response: body } = request;

		// The body is empty. Nothing more to send.
		if(!body) return;

		if('content-length' in headers ){
			// Nothing to do if the body is empty
			if (headers['content-length'] === 0){
				return;
			}
		}

		if(!('transfer-encoding' in headers)){
			return;
		}

		let context = {
			lastChunkReceived: false,
			maxStackedBuffers: 4096,
			backpressure: false,
			written: 0,
			stackedBuffers: []
		};

		body.onData((chunk, isLast) => {
			const data = new Uint8Array(chunk);
			const sent = this._trySendChunk(socket, context, data);

			if(!sent && context.stackedBuffers.length >= context.maxStackedBuffers){
				body.cork(() => {
					body.setStatus('504 Gateway Timeout');
					body.end('The server is too busy to handle your request.');
				});
			}
		});

		body.onAborted(() => {
			const { headers } = request;

			if('content-length' in headers){
				/**
				 * @see https://www.ietf.org/rfc/rfc2616.txt
				 * 8.2.2 Monitoring Connections for Error Status Messages
				 *
				 * If the body was preceded by a Content-Length header, the client MUST
				 * close the connection. However, when pipelining is used, we would abort every requests
				 * in the pipeline. So we just send buffers filled with 0s until content-length is reached.
				 */

				socket.destroy(Buffer.alloc(headers['content-length'] - context.written));
			}else if(headers['content-encoding'] === 'chunked'){
				/**
				 * @FIXME I suspect that this is not the right way to handle this.
				 *   We may have to compensate for the chunk size if it has only been partially received
				 *   before sending the 0 chunk.
				 */
				/**
				 * @see https://www.ietf.org/rfc/rfc2616.txt
				 * 8.2.2 Monitoring Connections for Error Status Messages
				 *
				 * If the body is being set using a "chunked" encoding (section 3.6), a zero length
				 *  chunk and empty trailer MAY be used to prematurely mark the end of the message.
				 */
				socket.write('0\r\n\r\n', 'utf8');
			}
		});
	}
}

module.exports = Sender;