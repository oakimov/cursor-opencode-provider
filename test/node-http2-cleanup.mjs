import assert from "node:assert/strict"
import http2 from "node:http2"
import { installSessionInvalidationForTests } from "../dist/transport/connect.js"

const server = http2.createServer()
const remoteReady = new Promise((resolve) => server.once("session", resolve))
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})

try {
  const address = server.address()
  assert(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const client = http2.connect(origin)
  await new Promise((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
  installSessionInvalidationForTests(origin, client)
  const remote = await remoteReady
  const closed = new Promise((resolve) => client.once("close", resolve))
  remote.destroy()
  await closed
  assert.equal(client.closed || client.destroyed, true)
} finally {
  await new Promise((resolve) => server.close(resolve))
}

console.log("node-http2-cleanup=ok")
