import { startServer } from "./service";

try {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORTは0〜65535の整数で指定してください");
  }
  const server = await startServer({
    databasePath:
      process.env.SURENECO_SERVER_DB ?? "server/data/monitor.sqlite",
    port,
  });
  console.log(`sureneco local server: ${server.url}`);
  const stop = () => {
    void server.close().catch(() => {
      console.error("サーバーの停止に失敗しました");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : "起動に失敗しました");
  process.exitCode = 1;
}
