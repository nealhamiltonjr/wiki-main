// Hello World Plugin server routes — Fastify plugin.
export default async function helloWorldPlugin(app, opts, done) {
  app.get("/", async () => {
    return { hello: "from plugin server route" };
  });
  done();
}
