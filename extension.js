"use strict";

const vscode = require("vscode");
const { DOMParser } = require("xmldom");

/**
 * This class implements a WebviewViewProvider that displays our text area UI
 * where the user can paste their XML in, and that XML then gets parsed and changed into code changes.
 */
class XmlToCodeViewProvider {
  constructor(context) {
    this.context = context;
    this.viewId = "xmlToCodeView";
    console.log("XmlToCodeViewProvider initialized.");
  }

  /**
   * Called when our custom view (xmlToCodeView) is resolved.
   */
  resolveWebviewView(webviewView, _context, _token) {
    console.log(`Resolving webview for view ID: ${this.viewId}`);
    this._view = webviewView;

    // Enable scripts in the webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri], // Adjust as needed
    };

    // Generate a nonce
    const nonce = this.getNonce();

    // Set the HTML content with the nonce
    webviewView.webview.html = this.getWebviewContent(webviewView.webview, nonce);

    // Handle messages sent from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("Message received from webview:", message);
      switch (message.command) {
        case "applyXml":
          try {
            await this.applyXmlModifications(message.payload);
          } catch (err) {
            vscode.window.showErrorMessage("Error applying XML modifications: " + err.message);
            console.error("Error applying XML modifications:", err);
          }
          break;
        default:
          console.warn("Unknown command received:", message.command);
      }
    });

    console.log("WebviewView has been successfully resolved.");
  }

  /**
   * Provide the HTML for our sidebar UI, including a textarea and button.
   * Incorporates a nonce for security.
   */
  getWebviewContent(webview, nonce) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>XML to Code</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    /* Reset some default styles */
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      height: 100%;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #f3f3f3;
      color: #333;
      display: flex;
      flex-direction: column;
    }

    body {
      padding: 20px;
    }

    h2 {
      margin-bottom: 10px;
      font-size: 1.5em;
      color: #007acc;
    }

    p.description {
      margin-bottom: 20px;
      font-size: 0.9em; /* Reduced font size */
      color: #555;
    }

    textarea {
      width: 100%;
      flex: 1; /* Allows the textarea to grow */
      padding: 15px;
      font-size: 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
      resize: vertical;
      background-color: #fff;
      color: #333;
      margin-bottom: 20px; /* Space between textarea and button */
    }

    .button-container {
      display: flex;
      justify-content: flex-start;
      margin-bottom: 20px;
    }

    button {
      padding: 10px 25px;
      font-size: 14px;
      color: #fff;
      background-color: #007acc;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background-color 0.3s ease;
    }

    button:hover {
      background-color: #005f99;
    }

    footer {
      padding-top: 20px;
      border-top: 1px solid #ccc;
      text-align: center;
      font-size: 0.85em;
      color: #777;
      margin-top: auto; /* Pushes the footer to the bottom */
    }

    footer a {
      color: #007acc;
      text-decoration: none;
      margin: 0 5px;
    }

    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h2>Paste your XML</h2>
  <p class="description">Here you can paste your XML output from the app repository prompt, and it will be transformed into your code changes.</p>

  <textarea id="xmlInput" placeholder="Enter XML here..."></textarea>

  <div class="button-container">
    <button id="applyChanges">Apply Changes</button>
  </div>

  <footer>
    Extension is made with ❤️ by Tim van de Vathorst |
    <a href="https://github.com/timvdv" target="_blank">GitHub</a> |
    <a href="https://www.paypal.me/timvandevathorst" target="_blank">Donate</a>
  </footer>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('applyChanges').addEventListener('click', () => {
      const xmlInput = document.getElementById('xmlInput').value;
      vscode.postMessage({
        command: 'applyXml',
        payload: xmlInput
      });
    });
  </script>
</body>
</html>`;
  }

  /**
   * Generate a nonce - a random string for CSP.
   */
  getNonce() {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Parse the XML instructions and perform the actions (create/rewrite) on the files.
   */
  async applyXmlModifications(xmlInput) {
    console.log("Received XML input for modifications.");
    if (!xmlInput) {
      vscode.window.showErrorMessage("No XML input provided.");
      console.warn("applyXmlModifications called with empty XML input.");
      return;
    }

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlInput, "text/xml");

    // Collect all <file> tags
    const fileNodes = xmlDoc.getElementsByTagName("file");
    for (let i = 0; i < fileNodes.length; i++) {
      const fileNode = fileNodes.item(i);
      // Extract attributes:
      const filePath = fileNode.getAttribute("path");
      const action = fileNode.getAttribute("action");

      // Gather <change> nodes within this <file>
      const changeNodes = fileNode.getElementsByTagName("change");
      for (let j = 0; j < changeNodes.length; j++) {
        const changeNode = changeNodes.item(j);

        // Extract the <content> text
        const contentNode = changeNode.getElementsByTagName("content").item(0);
        if (!contentNode) {
          console.warn(`No <content> found in <change> tag for file: ${filePath}`);
          continue;
        }

        // The raw text might be enclosed in ===. Let's strip them out:
        let rawContent = contentNode.textContent || "";
        rawContent = rawContent.trim();

        // Attempt to isolate the code between the first and last occurrence of ===
        const firstDelimiter = rawContent.indexOf("===");
        const lastDelimiter = rawContent.lastIndexOf("===");
        let finalCode = rawContent;
        if (firstDelimiter !== -1 && lastDelimiter !== -1 && firstDelimiter !== lastDelimiter) {
          finalCode = rawContent.substring(firstDelimiter + 3, lastDelimiter).trim();
        }

        // Now we have the complete file content in finalCode
        if (filePath) {
          if (action === "create" || action === "rewrite") {
            await writeFile(filePath, finalCode);
            console.log(`${action}d file: ${filePath}`);
          } else {
            vscode.window.showErrorMessage(`Unsupported action: ${action}`);
            console.error(`Unsupported action: ${action} for file: ${filePath}`);
          }
        } else {
          console.warn("File path is missing in <file> tag.");
        }
      }
    }

    vscode.window.showInformationMessage("XML modifications applied successfully.");
    console.log("XML modifications have been applied successfully.");
  }
}

/**
 * Writes (or overwrites) the given file with the provided content.
 */
async function writeFile(filePath, content) {
  if (!vscode.workspace?.workspaceFolders?.length) {
    vscode.window.showErrorMessage("No workspace folder is open.");
    console.error("writeFile called but no workspace folder is open.");
    return;
  }

  // Resolve the file path in the first workspace folder for simplicity
  const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
  const fileUri = vscode.Uri.joinPath(workspaceUri, filePath);

  try {
    // Convert the string content to a Uint8Array
    const encoder = new TextEncoder();
    const fileData = encoder.encode(content);

    await vscode.workspace.fs.writeFile(fileUri, fileData);
    console.log(`File written successfully: ${filePath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to write file: ${filePath}`);
    console.error(`Error writing file ${filePath}:`, error);
  }
}

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

  // Automatically reveal the XML to Code view upon activation
  vscode.commands.executeCommand('xmlToCode.openView');
  console.log("XML to Code view has been opened programmatically.");
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
