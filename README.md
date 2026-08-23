# Gridora

Gridora is a multi-organization game server operations platform. It provides a
Cloudflare-native control plane for provisioning and operating isolated Linux
Steam dedicated servers on managed VPS nodes.

The implementation follows [PRODUCT.md](./PRODUCT.md). The control plane runs
on Cloudflare Workers, Durable Objects, Workflows, Queues, D1, and R2. Game
processes remain on Ubuntu VPS nodes managed through Cloudflare Tunnel.

## License

[MIT](./LICENSE)
