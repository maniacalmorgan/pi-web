// Send a one-off test push to every registered subscription (proves end-to-end
// delivery without waiting for a real turn to finish).
import { initPush, sendToAll } from "../push.mjs";

initPush();
await sendToAll({ title: "Pi", body: process.argv[2] || "Test notification 👋", url: "/", tag: "pi-test" });
console.log("push dispatched to all subscriptions");
