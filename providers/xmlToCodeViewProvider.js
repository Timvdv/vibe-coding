"use strict";

const vscode = require("vscode");
const { DOMParser, XMLSerializer } = require("xmldom");
const { writeFile } = require("../utils/fileUtils");
const fs = require("fs");
const path = require("path");
const os = require("os"); // Moved require up for consistency

// 1) Helper to convert ===...=== blocks to CDATA
function convertTripleEqualsToCdata(xmlString) {
  const contentRegex = /<content\b[^>]*>([\s\S]*?)<\/content>/gi;
  return xmlString.replace(contentRegex, (match, inside) => {
    const firstIdx = inside.indexOf("===");
    const lastIdx = inside.lastIndexOf("===");

    if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
      const before = inside.substring(0, firstIdx);
      const code = inside.substring(firstIdx + 3, lastIdx);
      const after = inside.substring(lastIdx + 3);

      return `<content>${before}<![CDATA[${code}]]}${after}</content>`;
    }

    return match;
  });
}

/**
 * This class implements a WebviewViewProvider that displays our text area UI
 * where the user can paste XML instructions, which we then parse into code changes.
 */
class XmlToCodeViewProvider {
  constructor(context) {
    this.context = context;
    this.viewId = "xmlToCodeView";
    this.pendingChanges = [];
  }

  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    const nonce = this.getNonce();
    webviewView.webview.html = this.getWebviewContent(webviewView.webview, nonce);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "applyXml":
          try {
            await this.prepareXmlModifications(message.payload);
            webviewView.webview.postMessage({
              command: "displayChanges",
              payload: this.pendingChanges,
            });
          } catch (err) {
            vscode.window.showErrorMessage("Error preparing XML modifications: " + err.message);
          }
          break;

        case "confirmApply":
          try {
            const selectedIndexes = (message.payload && message.payload.selectedIndexes) || [];
            await this.applyPendingChanges(selectedIndexes);
            webviewView.webview.postMessage({ command: "changesApplied" });
          } catch (err) {
            vscode.window.showErrorMessage("Error applying XML modifications: " + err.message);
          }
          break;

        case "previewChanges":
          try {
            await vscode.commands.executeCommand("xmlToCode.previewChanges");
          } catch (err) {
            vscode.window.showErrorMessage("Error previewing changes: " + err.message);
          }
          break;

        case "viewDiff":
          try {
            const { index } = message.payload;
            await this.viewDiff(index);
          } catch (err) {
            vscode.window.showErrorMessage("Error viewing diff: " + err.message);
          }
          break;

        case 'cancelChanges':
          this.pendingChanges = [];
          webviewView.webview.postMessage({ command: 'clearChanges' });
          break;

        default:
          break;
      }
    });
  }

  getWebviewContent(_webview, nonce) {
    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "providers",
      "webview",
      "webview.html"
    );
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");
    html = html.replace(/\${nonce}/g, nonce);
    return html;
  }

  getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * The main function that parses the XML input. We'll:
   * 1) Auto-convert the user's === blocks into CDATA if possible.
   * 2) Wrap the XML input within a single root element to handle multiple top-level elements.
   * 3) Parse with xmldom.
   * 4) Gather <file> nodes with action="create", "rewrite", or "delete".
   */
  async prepareXmlModifications(xmlInput) {
    if (!xmlInput) {
      vscode.window.showErrorMessage("No XML input provided.");
      return;
    }

    // 1) Convert triple-equals to CDATA inside <content> blocks.
    let processedXml = convertTripleEqualsToCdata(xmlInput);

    // 2) Wrap the XML input with a single root element to ensure it's well-formed
    processedXml = `<changes>${processedXml}</changes>`;

    console.log("Processed XML after wrapping:", processedXml); // Debugging

    // 3) Parse with xmldom
    let xmlDoc;
    try {
      const parser = new DOMParser({
        errorHandler: {
          warning: () => { },
          error: () => { },
          fatalError: () => { },
        },
      });
      xmlDoc = parser.parseFromString(processedXml, "text/xml");
    } catch (e) {
      vscode.window.showErrorMessage("Failed to parse XML input.");
      console.error("XML Parsing Error:", e);
      return;
    }

    // Check if parser threw error
    const parserErrors = xmlDoc.getElementsByTagName("parsererror");
    if (parserErrors.length > 0) {
      vscode.window.showErrorMessage("XML input contains parser errors.");
      console.error("Parser Errors:", parserErrors[0].textContent);
      return;
    }

    this.pendingChanges = [];

    // Grab all <file> nodes
    const fileNodes = xmlDoc.getElementsByTagName("file");
    console.log("Number of <file> nodes found:", fileNodes.length); // Debugging

    if (!fileNodes || fileNodes.length === 0) {
      vscode.window.showWarningMessage("No <file> nodes found in XML.");
    }

    for (let i = 0; i < fileNodes.length; i++) {
      const fileNode = fileNodes.item(i);
      let filePath = fileNode.getAttribute("path");
      let action = fileNode.getAttribute("action");

      if (!filePath || !action) {
        continue;
      }

      // Normalize the file path
      filePath = this.normalizeFilePath(filePath);

      // Each <file> has 0..N <change> nodes (delete might not have a <change>)
      const changeNodes = fileNode.getElementsByTagName("change");

      if (action === "delete") {
        // Handle delete action
        let beforeContent = "";
        try {
          const workspaceUri = this.getWorkspaceUri();
          if (workspaceUri) {
            const fileUri = this.getFileUri(workspaceUri, filePath);
            beforeContent = await this.getFileContentFromUri(fileUri);
          }
        } catch (err) {
          // If the file doesn't exist, there's nothing to show in diff
          beforeContent = "";
        }

        // Add a change item with empty 'after'
        this.pendingChanges.push({
          filePath,
          action: "delete",
          description: `Delete file ${filePath}`,
          before: beforeContent,
          after: "",
        });
      } else {
        // For create or rewrite
        for (let j = 0; j < changeNodes.length; j++) {
          const changeNode = changeNodes.item(j);

          // Read description from <description>
          const descNodes = changeNode.getElementsByTagName("description");
          let description = "";
          if (descNodes && descNodes.length > 0) {
            description = descNodes.item(0).textContent.trim();
          }

          // Grab <content> node
          const contentNodes = changeNode.getElementsByTagName("content");
          if (!contentNodes || !contentNodes.length) {
            continue;
          }

          let rawCode = contentNodes.item(0).textContent.trim();

          // If action is "rewrite" and content is empty, treat as "delete"
          if (action === "rewrite" && !rawCode) {
            // Change action to "delete"
            action = "delete";

            // Handle delete action
            let beforeContent = "";
            try {
              const workspaceUri = this.getWorkspaceUri();
              if (workspaceUri) {
                const fileUri = this.getFileUri(workspaceUri, filePath);
                beforeContent = await this.getFileContentFromUri(fileUri);
              }
            } catch (err) {
              // If the file doesn't exist, there's nothing to show in diff
              beforeContent = "";
            }

            // Add a change item with empty 'after'
            this.pendingChanges.push({
              filePath,
              action: "delete",
              description: `Delete file ${filePath}`,
              before: beforeContent,
              after: "",
            });

            continue; // Skip to next changeNode
          }

          if (action === "create" || action === "rewrite") {
            // Add the create or rewrite change
            this.pendingChanges.push({
              filePath,
              action,
              description,
              before: action === "rewrite" ? await this.getFileContent(filePath) : "",
              after: rawCode,
            });
          }
        }
      }
    }

    if (this.pendingChanges.length === 0) {
      vscode.window.showWarningMessage("No valid changes were parsed from the XML.");
      return;
    }

    vscode.window.showInformationMessage("XML modifications prepared. Please review the changes.");
  }

  /**
   * Normalize the file path to handle absolute and relative paths.
   * If the path is relative, resolve it against the workspace root.
   * If the path is absolute, use it as is.
   * @param {string} filePath
   * @returns {string} normalized file path
   */
  normalizeFilePath(filePath) {
    // Check if the path is absolute
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }

    // If relative, ensure it starts with './' or '../' for consistency
    if (!filePath.startsWith("./") && !filePath.startsWith("../")) {
      filePath = `./${filePath}`;
    }

    return path.normalize(filePath);
  }

  /**
   * Get the workspace URI. Handles cases where there might be multiple workspace folders.
   * For simplicity, it uses the first workspace folder.
   * @returns {vscode.Uri | null}
   */
  getWorkspaceUri() {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      return vscode.workspace.workspaceFolders[0].uri;
    }
    vscode.window.showErrorMessage("No workspace folder is open.");
    return null;
  }

  /**
   * Resolve the file URI based on whether the path is absolute or relative.
   * @param {vscode.Uri} workspaceUri
   * @param {string} filePath
   * @returns {vscode.Uri}
   */
  getFileUri(workspaceUri, filePath) {
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(filePath);
    }
    return vscode.Uri.joinPath(workspaceUri, filePath);
  }

  /**
   * Helper function to get the current content of a file from its URI.
   */
  async getFileContentFromUri(fileUri) {
    try {
      const fileData = await vscode.workspace.fs.readFile(fileUri);
      return new TextDecoder().decode(fileData);
    } catch (err) {
      // If the file doesn't exist, return empty string
      return "";
    }
  }

  /**
   * Helper function to get the current content of a file using its path.
   * It handles both absolute and relative paths.
   */
  async getFileContent(filePath) {
    try {
      const workspaceUri = this.getWorkspaceUri();
      if (!workspaceUri) {
        return "";
      }

      const fileUri = this.getFileUri(workspaceUri, filePath);
      return await this.getFileContentFromUri(fileUri);
    } catch (err) {
      // If the file doesn't exist, return empty string
      return "";
    }
  }

  async viewDiff(index) {
    if (index < 0 || index >= this.pendingChanges.length) {
      vscode.window.showErrorMessage("Invalid change index");
      return;
    }
    const change = this.pendingChanges[index];
    const { filePath, before, after } = change;
    const workspaceUri = this.getWorkspaceUri();
    if (!workspaceUri) {
      return;
    }

    // Temporary files
    const tempDir = path.join(os.tmpdir(), `xml-to-code-diff-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Write original
    const originalFileName = `original_${path.basename(filePath)}`;
    const tempOrigPath = path.join(tempDir, originalFileName);
    fs.writeFileSync(tempOrigPath, before, "utf8");
    const tempOrigUri = vscode.Uri.file(tempOrigPath);

    // Write modified (could be empty for delete action)
    const modifiedFileName = `modified_${path.basename(filePath)}`;
    const tempModPath = path.join(tempDir, modifiedFileName);
    fs.writeFileSync(tempModPath, after, "utf8");
    const tempModUri = vscode.Uri.file(tempModPath);

    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        tempOrigUri,
        tempModUri,
        `${path.basename(filePath)} (Original) ↔ ${path.basename(filePath)} (Modified)`
      );
    } catch (error) {
      vscode.window.showErrorMessage("Failed to open diff view.");
    }
  }

  async applyPendingChanges(selectedIndexes) {
    // Only apply changes whose index is included in selectedIndexes
    const changesToApply = this.pendingChanges.filter((_, i) => selectedIndexes.includes(i));

    if (!changesToApply.length) {
      vscode.window.showInformationMessage("No changes selected to apply.");
      return;
    }

    for (const change of changesToApply) {
      const { filePath, action, after } = change;

      if (action === "delete") {
        await this.deleteFile(filePath);
      } else {
        await writeFile(filePath, after);
      }
    }
    vscode.window.showInformationMessage("Selected changes have been applied.");
    this.pendingChanges = [];
  }

  async deleteFile(filePath) {
    // Make sure we are in a workspace
    const workspaceUri = this.getWorkspaceUri();
    if (!workspaceUri) {
      return;
    }

    const fileUri = this.getFileUri(workspaceUri, filePath);

    try {
      // Will throw if the file doesn't exist
      await vscode.workspace.fs.delete(fileUri);
      vscode.window.showInformationMessage(`Deleted file: ${filePath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to delete file ${filePath}: ${err.message}`);
    }
  }
}

module.exports = {
  XmlToCodeViewProvider
};