"use strict";

const vscode = require("vscode");
const { DOMParser, XMLSerializer } = require("xmldom");
const { writeFile } = require("../utils/fileUtils");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

      return `${before}${code}${after}`;
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
    webviewView.webview.html = this.getWebviewContent(
      webviewView.webview,
      nonce
    );

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
            vscode.window.showErrorMessage(
              "Error preparing XML modifications: " + err.message
            );
          }
          break;

        case "confirmApply":
          try {
            const selectedIndexes =
              (message.payload && message.payload.selectedIndexes) || [];
            await this.applyPendingChanges(selectedIndexes);
            webviewView.webview.postMessage({ command: "changesApplied" });
          } catch (err) {
            vscode.window.showErrorMessage(
              "Error applying XML modifications: " + err.message
            );
          }
          break;

        case "previewChanges":
          try {
            await vscode.commands.executeCommand("xmlToCode.previewChanges");
          } catch (err) {
            vscode.window.showErrorMessage(
              "Error previewing changes: " + err.message
            );
          }
          break;

        case "viewDiff":
          try {
            const { index } = message.payload;
            await this.viewDiff(index);
          } catch (err) {
            vscode.window.showErrorMessage(
              "Error viewing diff: " + err.message
            );
          }
          break;

        case "cancelChanges":
          this.pendingChanges = [];
          webviewView.webview.postMessage({ command: "clearChanges" });
          break;

        case "getFileTreeWithContents":
          try {
            const workspaceUri = this.getWorkspaceUri();
            if (!workspaceUri) {
              vscode.window.showErrorMessage("No workspace found.");
              return;
            }
            const workspacePath = workspaceUri.fsPath;
            const { treeStr, fileBlocks } =
              this.generateFileTreeWithContents(workspacePath);
            const output = `<file_map>\n${treeStr}\n</file_map>\n${fileBlocks}`;
        
            webviewView.webview.postMessage({
              command: "fileTreeOutput",
              payload: output,
            });
          } catch (err) {
            vscode.window.showErrorMessage(
              "Error generating file tree: " + err.message
            );
          }
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
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  async prepareXmlModifications(xmlInput) {
    if (!xmlInput) {
      vscode.window.showErrorMessage("No XML input provided.");
      return;
    }

    let processedXml = convertTripleEqualsToCdata(xmlInput);
    processedXml = `${processedXml}`;

    console.log("Processed XML after wrapping:", processedXml);

    let xmlDoc;
    try {
      const parser = new DOMParser({
        errorHandler: {
          warning: () => {},
          error: () => {},
          fatalError: () => {},
        },
      });
      xmlDoc = parser.parseFromString(processedXml, "text/xml");
    } catch (e) {
      vscode.window.showErrorMessage("Failed to parse XML input.");
      console.error("XML Parsing Error:", e);
      return;
    }

    const parserErrors = xmlDoc.getElementsByTagName("parsererror");
    if (parserErrors.length > 0) {
      vscode.window.showErrorMessage("XML input contains parser errors.");
      console.error("Parser Errors:", parserErrors[0].textContent);
      return;
    }

    this.pendingChanges = [];
    const fileNodes = xmlDoc.getElementsByTagName("file");
    console.log("Number of  nodes found:", fileNodes.length);

    if (!fileNodes || fileNodes.length === 0) {
      vscode.window.showWarningMessage("No  nodes found in XML.");
    }

    for (let i = 0; i < fileNodes.length; i++) {
      const fileNode = fileNodes.item(i);
      let filePath = fileNode.getAttribute("path");
      let action = fileNode.getAttribute("action");

      if (!filePath || !action) {
        continue;
      }

      filePath = this.normalizeFilePath(filePath);
      const changeNodes = fileNode.getElementsByTagName("change");

      if (action === "delete") {
        let beforeContent = "";
        try {
          const workspaceUri = this.getWorkspaceUri();
          if (workspaceUri) {
            const fileUri = this.getFileUri(workspaceUri, filePath);
            beforeContent = await this.getFileContentFromUri(fileUri);
          }
        } catch (err) {
          beforeContent = "";
        }

        this.pendingChanges.push({
          filePath,
          action: "delete",
          description: `Delete file ${filePath}`,
          before: beforeContent,
          after: "",
        });
      } else {
        for (let j = 0; j < changeNodes.length; j++) {
          const changeNode = changeNodes.item(j);
          const descNodes = changeNode.getElementsByTagName("description");
          let description = "";
          if (descNodes && descNodes.length > 0) {
            description = descNodes.item(0).textContent.trim();
          }
          const contentNodes = changeNode.getElementsByTagName("content");
          if (!contentNodes || !contentNodes.length) {
            continue;
          }
          let rawCode = contentNodes.item(0).textContent.trim();

          if (action === "rewrite" && !rawCode) {
            action = "delete";
            let beforeContent = "";
            try {
              const workspaceUri = this.getWorkspaceUri();
              if (workspaceUri) {
                const fileUri = this.getFileUri(workspaceUri, filePath);
                beforeContent = await this.getFileContentFromUri(fileUri);
              }
            } catch (err) {
              beforeContent = "";
            }
            this.pendingChanges.push({
              filePath,
              action: "delete",
              description: `Delete file ${filePath}`,
              before: beforeContent,
              after: "",
            });
            continue;
          }

          if (action === "create" || action === "rewrite") {
            this.pendingChanges.push({
              filePath,
              action,
              description,
              before:
                action === "rewrite" ? await this.getFileContent(filePath) : "",
              after: rawCode,
            });
          }
        }
      }
    }

    if (this.pendingChanges.length === 0) {
      vscode.window.showWarningMessage(
        "No valid changes were parsed from the XML."
      );
      return;
    }

    vscode.window.showInformationMessage(
      "XML modifications prepared. Please review the changes."
    );
  }

  normalizeFilePath(filePath) {
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }
    if (!filePath.startsWith("./") && !filePath.startsWith("../")) {
      filePath = `./${filePath}`;
    }
    return path.normalize(filePath);
  }

  getWorkspaceUri() {
    if (
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
    ) {
      return vscode.workspace.workspaceFolders[0].uri;
    }
    vscode.window.showErrorMessage("No workspace folder is open.");
    return null;
  }

  getFileUri(workspaceUri, filePath) {
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(filePath);
    }
    return vscode.Uri.joinPath(workspaceUri, filePath);
  }

  async getFileContentFromUri(fileUri) {
    try {
      const fileData = await vscode.workspace.fs.readFile(fileUri);
      return new TextDecoder().decode(fileData);
    } catch (err) {
      return "";
    }
  }

  async getFileContent(filePath) {
    try {
      const workspaceUri = this.getWorkspaceUri();
      if (!workspaceUri) {
        return "";
      }
      const fileUri = this.getFileUri(workspaceUri, filePath);
      return await this.getFileContentFromUri(fileUri);
    } catch (err) {
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
    const tempDir = path.join(os.tmpdir(), `xml-to-code-diff-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const originalFileName = `original_${path.basename(filePath)}`;
    const tempOrigPath = path.join(tempDir, originalFileName);
    fs.writeFileSync(tempOrigPath, before, "utf8");
    const tempOrigUri = vscode.Uri.file(tempOrigPath);
    const modifiedFileName = `modified_${path.basename(filePath)}`;
    const tempModPath = path.join(tempDir, modifiedFileName);
    fs.writeFileSync(tempModPath, after, "utf8");
    const tempModUri = vscode.Uri.file(tempModPath);
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        tempOrigUri,
        tempModUri,
        `${path.basename(filePath)} (Original) ↔ ${path.basename(
          filePath
        )} (Modified)`
      );
    } catch (error) {
      vscode.window.showErrorMessage("Failed to open diff view.");
    }
  }

  async applyPendingChanges(selectedIndexes) {
    const changesToApply = this.pendingChanges.filter((_, i) =>
      selectedIndexes.includes(i)
    );

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
    const workspaceUri = this.getWorkspaceUri();
    if (!workspaceUri) {
      return;
    }
    const fileUri = this.getFileUri(workspaceUri, filePath);
    try {
      await vscode.workspace.fs.delete(fileUri);
      vscode.window.showInformationMessage(`Deleted file: ${filePath}`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to delete file ${filePath}: ${err.message}`
      );
    }
  }

  generateFileTreeWithContents(dir, prefix = "") {
    let treeStr = "";
    let fileBlocks = "";
    const items = fs.readdirSync(dir).sort();
  
    items.forEach((item, index) => {
      const fullPath = path.join(dir, item);
      const isLast = index === items.length - 1;
      const branch = isLast ? "└── " : "├── ";
      treeStr += prefix + branch + item + "\n";
  
      if (fs.statSync(fullPath).isDirectory()) {
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        const result = this.generateFileTreeWithContents(fullPath, newPrefix);
        treeStr += result.treeStr;
        fileBlocks += result.fileBlocks;
      } else {
        fileBlocks += ""; // simplified for debugging
      }
    });
  
    console.log({ treeStr, fileBlocks }); // IMPORTANT: Check your extension logs
    return { treeStr, fileBlocks };
  }
}

module.exports = {
  XmlToCodeViewProvider,
};