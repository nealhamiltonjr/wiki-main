// Hello World Plugin — slash command + toolbar button + settings panel.
// Demonstrates the full PluginAPI contract without any build tooling.
export default function register(api) {
  const { Tiptap, React, registerTiptapExtension, registerSlashCommand, registerToolbarItem, registerSettingsPanel } = api;

  // 1. A simple Node extension that stores an attribute.
  const HelloWorldNode = Tiptap.Node.create({
    name: "helloWorld",
    group: "block",
    atom: true,
    addAttributes() {
      return { message: { default: "Hello from plugin!" } };
    },
    parseHTML() {
      return [{ tag: "div[data-hello-world]" }];
    },
    renderHTML({ node }) {
      return ["div", { "data-hello-world": "true", style: "background:#f0f9ff;padding:8px 12px;border-radius:6px;border:1px solid #bae5fd;" }, node.attrs.message];
    },
  });
  registerTiptapExtension(HelloWorldNode);

  // 2. Slash command to insert the node.
  registerSlashCommand({
    name: "hello-world-insert",
    label: "Insert Hello World block",
    icon: "👋",
    keywords: ["hello", "greeting"],
    run(editor) {
      editor.chain().focus().insertContent({ type: "helloWorld" }).run();
    },
  });

  // 3. Toolbar button.
  registerToolbarItem({
    id: "hello-world-button",
    label: "Hello World",
    onPress(editor) {
      editor.chain().focus().insertContent({ type: "helloWorld" }).run();
    },
    isActive(editor) {
      return editor.isActive("helloWorld");
    },
  });

  // 4. Settings panel.
  function SettingsPanel() {
    return React.createElement("div", { style: { padding: "12px" } },
      React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 600, marginBottom: "8px" } }, "Hello World Plugin"),
      React.createElement("p", { style: { fontSize: "0.875rem", color: "#666" } }, "This is a demo plugin settings panel. No real settings yet!"),
    );
  }
  registerSettingsPanel({ id: "hello-world-settings", label: "Hello World", render: () => SettingsPanel() });
}
