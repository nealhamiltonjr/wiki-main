// Hello World Plugin server routes — Fastify plugin.
export default function helloWorldPlugin(app, opts, done) {
  app.get("/", { config: { access: "public" } }, async () => {
    return { hello: "from plugin server route" };
  });
  done();
}
