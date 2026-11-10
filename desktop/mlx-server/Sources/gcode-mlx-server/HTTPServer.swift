import Foundation
import Network

/// One parsed request. A connection carries exactly one (every response closes it).
struct HTTPRequest {
    let method: String
    let path: String
    let body: Data
}

/// The reply side of a connection, safe to use from the inference queue.
final class HTTPClient {
    private let connection: NWConnection
    private let lock = NSLock()
    private var closed = false
    private var streaming = false

    init(connection: NWConnection) { self.connection = connection }

    /// True once the peer hung up or a write failed: the running request stops at its next step.
    var isClosed: Bool { lock.withLock { closed } }
    var hasStartedStream: Bool { lock.withLock { streaming } }

    func markClosed() { lock.withLock { closed = true } }

    private func write(_ data: Data) {
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if error != nil { self?.markClosed() }
        })
    }

    func respond(status: Int, json: Any) {
        let body = (try? JSONSerialization.data(withJSONObject: json, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
        var head = "HTTP/1.1 \(status) \(HTTPClient.reason(status))\r\n"
        head += "Content-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        write(Data(head.utf8) + body)
        finish()
    }

    func beginStream() {
        lock.withLock { streaming = true }
        write(Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".utf8))
    }

    func sendEvent(_ json: Any) {
        guard let body = try? JSONSerialization.data(withJSONObject: json, options: [.withoutEscapingSlashes]) else { return }
        write(Data("data: ".utf8) + body + Data("\n\n".utf8))
    }

    func sendDone() { write(Data("data: [DONE]\n\n".utf8)) }

    func finish() {
        connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
            self?.markClosed()
            self?.connection.cancel()
        })
    }

    func abort() {
        markClosed()
        connection.cancel()
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: "OK"
        case 400: "Bad Request"
        case 403: "Forbidden"
        case 404: "Not Found"
        case 413: "Payload Too Large"
        case 503: "Service Unavailable"
        default: "Internal Server Error"
        }
    }
}

/// A loopback-only HTTP/1.1 server: reads one request per connection and hands it over.
final class HTTPServer {
    /// A managed request can carry a whole context window of JSON.
    private static let maxBody = 256 * 1024 * 1024
    private static let maxHeader = 64 * 1024

    private let listener: NWListener
    private let queue = DispatchQueue(label: "gcode.mlx.http", attributes: .concurrent)
    private let handler: (HTTPRequest, HTTPClient) -> Void

    init(host: String, port: UInt16, handler: @escaping (HTTPRequest, HTTPClient) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { throw ServerError.badRequest("Invalid port \(port)") }
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: endpointPort)
        listener = try NWListener(using: parameters)
        self.handler = handler
    }

    func start(onFailure: @escaping (String) -> Void) {
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state { onFailure("Listener failed: \(error)") }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        let client = HTTPClient(connection: connection)
        connection.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled: client.markClosed()
            default: break
            }
        }
        connection.start(queue: queue)
        read(connection, client, Data(), dispatched: false)
    }

    /// Keeps reading after the request is dispatched: the end of the stream means the caller hung up.
    private func read(_ connection: NWConnection, _ client: HTTPClient, _ received: Data, dispatched: Bool) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if error != nil || isComplete { client.markClosed(); if !dispatched { connection.cancel() }; return }
            var buffer = received
            if !dispatched, let data { buffer.append(data) }
            var nowDispatched = dispatched
            if !dispatched {
                switch Self.parse(buffer) {
                case .incomplete: break
                case .failed(let status, let message):
                    client.respond(status: status, json: ["error": ["code": status, "message": message, "type": "invalid_request_error"]])
                    return
                case .request(let request):
                    nowDispatched = true
                    buffer = Data()
                    self.handler(request, client)
                }
            }
            self.read(connection, client, buffer, dispatched: nowDispatched)
        }
    }

    private enum Parsed {
        case incomplete
        case failed(Int, String)
        case request(HTTPRequest)
    }

    private static func parse(_ buffer: Data) -> Parsed {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            return buffer.count > maxHeader ? .failed(400, "Request header is too large.") : .incomplete
        }
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else { return .failed(400, "Request header is not UTF-8.") }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count >= 2 else { return .failed(400, "Malformed request line.") }
        var length = 0
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if name == "content-length" {
                guard let parsed = Int(value), parsed >= 0 else { return .failed(400, "Invalid Content-Length.") }
                length = parsed
            }
            // G-Code's own clients send no Origin. A page in a browser always does, and has no business here.
            if name == "origin" { return .failed(403, "Browser requests are not accepted.") }
        }
        if length > maxBody { return .failed(413, "Request body is too large.") }
        let bodyStart = end.upperBound
        guard buffer.count - (bodyStart - buffer.startIndex) >= length else { return .incomplete }
        let path = String(parts[1]).components(separatedBy: "?")[0]
        return .request(HTTPRequest(method: String(parts[0]), path: path, body: buffer[bodyStart..<(bodyStart + length)]))
    }
}
