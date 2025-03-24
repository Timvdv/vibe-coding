"use strict";

const vscode = require("vscode");
const { DOMParser, XMLSerializer } = require("xmldom");
const { writeFile } = require("../utils/fileUtils");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  convertTripleEqualsToCdata,
  getNonce,
  normalizeFilePath,
  getWorkspaceUri,
  getFileUri,
  getFileContentFromUri,
  getFileContent
} = require("./xmlToCodeHelpers");

/**
 * This class implements the XML to Code View Provider.
 */
class XmlToCodeViewProvider {
  constructor(context) {
    this.context = context;
    this.viewId = "xmlToCodeView";
    this.pendingChanges = [];
  }

  // --- Webview Setup and Message Handling ---

  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    const nonce = getNonce();
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
        case "cancelChanges":
          this.pendingChanges = [];
          webviewView.webview.postMessage({ command: "clearChanges" });
          break;
        case "getFileTree":
          try {
            const fileTree = await this.getWorkspaceFileTree();
            webviewView.webview.postMessage({
              command: "displayFileTree",
              payload: fileTree
            });
          } catch (err) {
            vscode.window.showErrorMessage("Error getting file tree: " + err.message);
          }
          break;
        case "copyFileTreeOutput":
          try {
            const { instructions } = message.payload;
            await this.copyFileTreeAsXml(instructions);
            webviewView.webview.postMessage({ command: "fileTreeOutputCopied" });
          } catch (err) {
            vscode.window.showErrorMessage("Error copying file tree output: " + err.message);
          }
          break;
        default:
          break;
      }
    });
  }

  getWebviewContent(webview, nonce) {
    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "providers",
      "webview",
      "webview.html"
    );
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");

    // Generate URI for external JS file
    const jsPath = vscode.Uri.joinPath(this.context.extensionUri, "providers", "webview", "webview.js");
    const webviewJsUri = webview.asWebviewUri(jsPath);
    
    // Generate URI for external CSS file
    const cssPath = vscode.Uri.joinPath(this.context.extensionUri, "providers", "webview", "webview.css");
    const webviewCssUri = webview.asWebviewUri(cssPath);
    
    console.log("JS Path:", jsPath);
    console.log("JS URI for webview:", webviewJsUri);
    console.log("CSS Path:", cssPath);
    console.log("CSS URI for webview:", webviewCssUri);
    console.log("Webview CSP Source:", webview.cspSource);

    // Replace placeholders with actual values
    html = html.replace(/\${nonce}/g, nonce);
    html = html.replace(/\${webviewJsUri}/g, webviewJsUri.toString());
    html = html.replace(/\${webviewCssUri}/g, webviewCssUri.toString());
    html = html.replace(/\${cspSource}/g, webview.cspSource);
    
    // Log the final HTML content to debug loading issues
    console.log("Final HTML content with replaced URIs:", html);
    
    return html;
  }

  // --- XML Parsing and Modification Preparation ---
  async prepareXmlModifications(xmlInput) {
    if (!xmlInput) {
      vscode.window.showErrorMessage("No XML input provided.");
      return;
    }

    // Convert triple-equals blocks and wrap with a root element
    let processedXml = convertTripleEqualsToCdata(xmlInput);
    processedXml = `<changes>${processedXml}</changes>`;
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
    console.log("Number of <file> nodes found:", fileNodes.length);

    if (!fileNodes || fileNodes.length === 0) {
      vscode.window.showWarningMessage("No <file> nodes found in XML.");
    }

    for (let i = 0; i < fileNodes.length; i++) {
      const fileNode = fileNodes.item(i);
      let filePath = fileNode.getAttribute("path");
      let action = fileNode.getAttribute("action");
      if (!filePath || !action) continue;

      filePath = normalizeFilePath(filePath);
      const changeNodes = fileNode.getElementsByTagName("change");

      if (action === "delete") {
        const beforeContent = await this.getBeforeContent(filePath);
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
          if (!contentNodes || !contentNodes.length) continue;
          let rawCode = contentNodes.item(0).textContent.trim();

          if (action === "rewrite" && !rawCode) {
            const beforeContent = await this.getBeforeContent(filePath);
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
              before: action === "rewrite" ? await getFileContent(filePath) : "",
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
   * Helper to retrieve the current content of a file.
   */
  async getBeforeContent(filePath) {
    let beforeContent = "";
    try {
      const workspaceUri = getWorkspaceUri();
      if (workspaceUri) {
        const fileUri = getFileUri(workspaceUri, filePath);
        beforeContent = await getFileContentFromUri(fileUri);
      }
    } catch (err) {
      beforeContent = "";
    }
    return beforeContent;
  }

  // --- Diff and Change Application Methods ---

  async viewDiff(index) {
    if (index < 0 || index >= this.pendingChanges.length) {
      vscode.window.showErrorMessage("Invalid change index");
      return;
    }
    const change = this.pendingChanges[index];
    const { filePath, before, after } = change;
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) return;

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
        `${path.basename(filePath)} (Original) ↔ ${path.basename(filePath)} (Modified)`
      );
    } catch (error) {
      vscode.window.showErrorMessage("Failed to open diff view.");
    }
  }

  async applyPendingChanges(selectedIndexes) {
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
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) return;
    const fileUri = getFileUri(workspaceUri, filePath);
    try {
      await vscode.workspace.fs.delete(fileUri);
      vscode.window.showInformationMessage(`Deleted file: ${filePath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to delete file ${filePath}: ${err.message}`);
    }
  }
  
  /**
   * Get the file tree of the workspace
   */
  async getWorkspaceFileTree() {
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) {
      vscode.window.showErrorMessage("No workspace folder is open");
      return [];
    }
    
    try {
      // Get all files in the workspace
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
      
      // Convert to a format suitable for the webview
      return files.map(file => {
        const relativePath = vscode.workspace.asRelativePath(file);
        return {
          path: relativePath,
          selected: false
        };
      }).sort((a, b) => a.path.localeCompare(b.path));
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get file tree: ${err.message}`);
      return [];
    }
  }
  
  /**
   * Copy the selected files from the file tree as XML
   */
  async copyFileTreeAsXml(instructions) {
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) return;
    
    try {
      // Get all files in the workspace
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
      
      // Generate XML for selected files
      let xml = `<changes>\n`;
      
      // Add instructions if provided
      if (instructions) {
        xml += `  <instructions>\n    ${instructions}\n  </instructions>\n`;
      }
      
      // Add files
      for (const file of files) {
        const relativePath = vscode.workspace.asRelativePath(file);
        const content = await getFileContentFromUri(file);
        
        xml += `  <file path="${relativePath}" action="rewrite">\n`;
        xml += `    <change>\n`;
        xml += `      <description>File content</description>\n`;
        xml += `      <content>===\n${content}\n===</content>\n`;
        xml += `    </change>\n`;
        xml += `  </file>\n`;
      }
      
      xml += `</changes>`;
      
      // Copy to clipboard
      await vscode.env.clipboard.writeText(xml);
      vscode.window.showInformationMessage("File tree XML copied to clipboard");
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to copy file tree as XML: ${err.message}`);
    }
  }
}

module.exports = {
  XmlToCodeViewProvider
};