
let buf = "";
const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1); nl = buf.indexOf("\n");
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    }
    // 其它 method 永不回——触发客户端超时
  }
});
