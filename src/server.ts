/**
 * 服务启动入口：加载配置、创建网关并监听 host/port。
 */
import { loadConfig } from "./config.ts";
import { createGateway } from "./gateway.ts";

const config = await loadConfig();
const server = createGateway(config);
server.listen(config.server.port, config.server.host, () => {
  console.log("LLM API gateway listening on http://" + config.server.host + ":" + config.server.port);
});
