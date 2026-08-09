import { createServer, type Server } from "node:http";

export type WorkerReadinessDependencies = {
  pingDatabase: () => Promise<unknown>;
  pingQueue: () => Promise<unknown>;
  isWorkerRunning: () => boolean;
};

export async function assertWorkerReady(dependencies: WorkerReadinessDependencies): Promise<void> {
  if (!dependencies.isWorkerRunning()) throw new Error("Worker is not running");
  await Promise.all([dependencies.pingDatabase(), dependencies.pingQueue()]);
}

export function startWorkerReadinessServer(
  dependencies: WorkerReadinessDependencies,
  port: number,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }
    void assertWorkerReady(dependencies).then(
      () => response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"service":"berry-worker","ready":true}'),
      () => response.writeHead(503, { "content-type": "application/json" }).end('{"ok":false,"service":"berry-worker","ready":false}'),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
