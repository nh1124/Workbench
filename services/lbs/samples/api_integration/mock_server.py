from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class AdvancedMockLBSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        print(f"\nReceived POST request for {self.path}")
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode() if content_length > 0 else "{}"
        print(f"Body: {body}")
        
        self.send_response(200 if "/login" in self.path else 201)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        
        if "/auth/login" in self.path:
            response = {"access_token": "mock-lbs-jwt-auth-token"}
        elif "/auth/link/confirm" in self.path:
            # Check for X-EXTERNAL-JWT
            ext_jwt = self.headers.get("X-EXTERNAL-JWT")
            if ext_jwt:
                print(f"Linking verified for External JWT: {ext_jwt}")
                response = {"message": f"External identity {ext_jwt} linked successfully"}
            else:
                response = {"error": "Missing X-EXTERNAL-JWT header"}
        elif "/auth/api-keys" in self.path:
            response = {
                "id": "key-999",
                "client_id": "mock-client",
                "api_key": "x-api-key-newly-generated-123",
                "message": "Key created successfully"
            }
        else:
            response = {"status": "created"}
            
        self.wfile.write(json.dumps(response).encode())

    def do_GET(self):
        print(f"\nReceived GET request for {self.path}")
        print(f"Headers: {self.headers}")
        
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        
        if "/auth/me" in self.path:
            response = {
                "user_id": "user-456",
                "username": "mock_user",
                "auth_method": "mapped_external" if "Bearer" in self.headers.get("Authorization", "") else "local"
            }
        elif "/tasks" in self.path:
            response = [{"id": "task-1", "title": "Mock Task via Auth", "load": 10}]
        elif "/health" in self.path:
            response = {"status": "healthy"}
        elif "/dashboard" in self.path:
            response = {"total_load": 42.0}
        else:
            response = {"message": "Mock LBS response"}
            
        self.wfile.write(json.dumps(response).encode())

if __name__ == "__main__":
    server = HTTPServer(('localhost', 8101), AdvancedMockLBSHandler)
    print("Starting Advanced Mock LBS Server on http://localhost:8101...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
