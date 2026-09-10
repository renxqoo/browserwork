/** p5 子进程：持有一个 view，打 READY 后保活（供父进程 SIGKILL 后查孤儿） */
export {};

const view = new Bun.WebView();
await view.navigate("about:blank");
await view.evaluate("1+1");
console.log("READY");
setInterval(() => {}, 1000);
