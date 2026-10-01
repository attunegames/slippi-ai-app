// The page's only door to the app: request/response calls plus event streams.
const { contextBridge, ipcRenderer } = require("electron");

const EVENTS = ["engine", "download", "play", "prepare", "train"];

contextBridge.exposeInMainWorld("phillip", {
  call: (channel, arg) => ipcRenderer.invoke(channel, arg),
  on: (event, fn) => {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event ${event}`);
    ipcRenderer.on(event, (_e, payload) => fn(payload));
  },
});
