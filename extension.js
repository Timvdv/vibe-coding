"use strict";

const vscode = require("vscode");
const { XmlToCodeViewProvider } = require("./providers/xmlToCodeViewProvider");

/**
 * Extension activation: register our WebviewViewProvider so it appears in the sidebar.
 */
function activate(context) {
  console.log("Activating xml-to-code extension.");
  const provider = new XmlToCodeViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      provider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  console.log("WebviewViewProvider registered successfully.");

  // Register command to open the XML to Code view
  const openViewCommand = vscode.commands.registerCommand('xmlToCode.openView', () => {
    console.log("Executing command 'xmlToCode.openView'.");
    vscode.commands.executeCommand('workbench.view.extension.xmlToCodeSidebar');
  });
  context.subscriptions.push(openViewCommand);

  // Register command to view diffs
  const viewDiffCommand = vscode.commands.registerCommand('xmlToCode.viewDiff', async (index) => {
    console.log("Executing command 'xmlToCode.viewDiff' with index:", index);
    const providerInstance = getProviderInstance(context);
    await providerInstance.viewDiff(index);
  });
  context.subscriptions.push(viewDiffCommand);

  // Automatically reveal the XML to Code view upon activation
  vscode.commands.executeCommand('xmlToCode.openView');
  console.log("XML to Code view has been opened programmatically.");
}

/**
 * Helper function to retrieve the XmlToCodeViewProvider instance.
 */
function getProviderInstance(context) {
  const provider = context.subscriptions.find(sub => sub instanceof XmlToCodeViewProvider);
  if (provider) {
    return provider;
  }
  throw new Error("XmlToCodeViewProvider instance not found.");
}

/**
 * Deactivate function.
 */
function deactivate() {
  console.log("Deactivating xml-to-code extension.");
}

module.exports = {
  activate,
  deactivate
};