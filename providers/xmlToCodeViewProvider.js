"use strict";

const vscode = require("vscode");
const { DOMParser } = require("xmldom");
const { writeFile } = require("../utils/fileUtils");
const fs = require('fs');
const path = require('path');

/**
 * This class implements a WebviewViewProvider that displays our text area UI
 * where the user can paste their XML in, and that XML then gets parsed and changed into code changes.
 */
class XmlToCodeViewProvider {
  constructor(context) {
    this.context = context;
    this.viewId = "xmlToCodeView";
    this.pendingChanges = []; // Container to store pending changes
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

    // Set the HTML content from external file
    webviewView.webview.html = this.getWebviewContent(webviewView.webview, nonce);

    // Handle messages sent from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("Message received from webview:", message);
      switch (message.command) {
        case "applyXml":
          try {
            await this.prepareXmlModifications(message.payload);
            // After preparing, send the pending changes back to the webview
            webviewView.webview.postMessage({
              command: "displayChanges",
              payload: this.pendingChanges,
            });
          } catch (err) {
            vscode.window.showErrorMessage("Error preparing XML modifications: " + err.message);
            console.error("Error preparing XML modifications:", err);
          }
          break;
        case "confirmApply":
          try {
            await this.applyPendingChanges();
            // Notify the webview that changes have been applied
            webviewView.webview.postMessage({
              command: "changesApplied",
            });
          } catch (err) {
            vscode.window.showErrorMessage("Error applying XML modifications: " + err.message);
            console.error("Error applying XML modifications:", err);
          }
          break;
        case "previewChanges":
          try {
            await vscode.commands.executeCommand('xmlToCode.previewChanges');
          } catch (err) {
            vscode.window.showErrorMessage("Error previewing changes: " + err.message);
            console.error("Error previewing changes:", err);
          }
          break;
        case "viewDiff":
          try {
            const { index } = message.payload;
            await this.viewDiff(index);
          } catch (err) {
            vscode.window.showErrorMessage("Error viewing diff: " + err.message);
            console.error("Error viewing diff:", err);
          }
          break;
        case "refreshChanges":
          // Handle any necessary refresh logic
          break;
        default:
          console.warn("Unknown command received:", message.command);
      }
    });

    console.log("WebviewView has been successfully resolved.");
  }

  /**
   * Provide the HTML for our sidebar UI by loading external HTML file.
   * Incorporates a nonce for security.
   */
  getWebviewContent(webview, nonce) {
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'providers', 'webview', 'webview.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

    // Replace placeholders with nonce
    html = html.replace(/\${nonce}/g, nonce);

    return html;
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
   * Prepare XML modifications by parsing and storing them in pendingChanges.
   */
  async prepareXmlModifications(xmlInput) {
    console.log("Preparing XML input for modifications.");
    if (!xmlInput) {
      vscode.window.showErrorMessage("No XML input provided.");
      console.warn("prepareXmlModifications called with empty XML input.");
      return;
    }

    let xmlDoc;
    try {
      const parser = new DOMParser();
      xmlDoc = parser.parseFromString(xmlInput, "text/xml");
      console.log("XML parsed successfully.");
    } catch (parseError) {
      vscode.window.showErrorMessage("Failed to parse XML input.");
      console.error("XML Parsing Error:", parseError);
      return;
    }

    // Check for parser errors
    const parserErrors = xmlDoc.getElementsByTagName("parsererror");
    if (parserErrors.length > 0) {
      vscode.window.showErrorMessage("XML input contains errors.");
      console.error("XML Parser Errors:", parserErrors[0].textContent);
      return;
    }

    // Clear any existing pending changes
    this.pendingChanges = [];

    // Collect all <file> tags
    const fileNodes = xmlDoc.getElementsByTagName("file");
    console.log(`${fileNodes.length} <file> elements found.`);
    for (let i = 0; i < fileNodes.length; i++) {
      const fileNode = fileNodes.item(i);
      // Extract attributes:
      const filePath = fileNode.getAttribute("path");
      const action = fileNode.getAttribute("action");

      console.log(`Processing file: ${filePath} with action: ${action}`);

      // Validate attributes
      if (!filePath || !action) {
        console.warn(`Missing 'path' or 'action' attribute in <file> tag at index ${i}.`);
        continue;
      }

      // Gather <change> nodes within this <file>
      const changeNodes = fileNode.getElementsByTagName("change");
      console.log(`Found ${changeNodes.length} <change> elements for file: ${filePath}.`);
      for (let j = 0; j < changeNodes.length; j++) {
        const changeNode = changeNodes.item(j);

        // Extract the <description> and <content> text
        const descriptionNode = changeNode.getElementsByTagName("description").item(0);
        const contentNode = changeNode.getElementsByTagName("content").item(0);

        if (!descriptionNode || !contentNode) {
          console.warn(`Missing <description> or <content> in <change> tag for file: ${filePath}.`);
          continue;
        }

        const description = descriptionNode.textContent.trim();
        let rawContent = contentNode.textContent || "";
        rawContent = rawContent.trim();

        // Attempt to isolate the code between the first and last occurrence of ===
        const firstDelimiter = rawContent.indexOf("===");
        const lastDelimiter = rawContent.lastIndexOf("===");
        let finalCode = rawContent;
        if (firstDelimiter !== -1 && lastDelimiter !== -1 && firstDelimiter !== lastDelimiter) {
          finalCode = rawContent.substring(firstDelimiter + 3, lastDelimiter).trim();
        } else {
          console.warn(`Content delimiters not found or improperly placed in <content> for file: ${filePath}.`);
        }

        // Read the current content of the file for comparison
        let beforeContent = "";
        if (action === "rewrite" || action === "create") {
          const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
          const fileUri = vscode.Uri.joinPath(workspaceUri, filePath);
          try {
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            beforeContent = new TextDecoder().decode(fileData);
            console.log(`Read existing content for file: ${filePath}.`);
          } catch (err) {
            if (action === "rewrite") {
              vscode.window.showErrorMessage(`Failed to read file for rewriting: ${filePath}`);
              console.error(`Error reading file ${filePath}:`, err);
              continue;
            } else if (action === "create") {
              beforeContent = ""; // File does not exist yet
              console.log(`File does not exist and will be created: ${filePath}.`);
            }
          }
        }

        // Store the change in the pendingChanges array
        this.pendingChanges.push({
          filePath,
          action,
          description,
          before: beforeContent,
          after: finalCode,
        });

        console.log(`Prepared ${action} for file: ${filePath} with description: ${description}.`);
      }
    }

    if (this.pendingChanges.length === 0) {
      vscode.window.showWarningMessage("No valid changes were prepared from the provided XML.");
      console.warn("No pending changes were generated after parsing XML.");
      return;
    }

    vscode.window.showInformationMessage("XML modifications prepared. Please review the changes.");
    console.log("XML modifications have been prepared successfully.");
  }

  /**
   * View diff of a specific change.
   */
  async viewDiff(index) {
    if (index < 0 || index >= this.pendingChanges.length) {
      vscode.window.showErrorMessage("Invalid change index.");
      console.error(`viewDiff called with invalid index: ${index}`);
      return;
    }

    const change = this.pendingChanges[index];
    const { filePath, action, before, after } = change;

    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showErrorMessage("No workspace folder is open.");
      console.error("viewDiff called but no workspace folder is open.");
      return;
    }

    const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
    const originalFileUri = vscode.Uri.joinPath(workspaceUri, filePath);

    // Prepare temporary files for diff
    const tempDir = path.join(require('os').tmpdir(), `xml-to-code-diff-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Temporary file for original content
    const tempOriginalFilePath = path.join(tempDir, `original_${path.basename(filePath)}`);
    fs.writeFileSync(tempOriginalFilePath, before, 'utf8');
    const tempOriginalFileUri = vscode.Uri.file(tempOriginalFilePath);

    // Temporary file for modified content
    const tempModifiedFilePath = path.join(tempDir, `modified_${path.basename(filePath)}`);
    fs.writeFileSync(tempModifiedFilePath, after, 'utf8');
    const tempModifiedFileUri = vscode.Uri.file(tempModifiedFilePath);

    try {
      // Use the built-in diff editor
      await vscode.commands.executeCommand(
        'vscode.diff',
        tempOriginalFileUri,
        tempModifiedFileUri,
        `${path.basename(filePath)} (Original) ↔ ${path.basename(filePath)} (Modified)`
      );
    } catch (error) {
      vscode.window.showErrorMessage("Failed to open diff view.");
      console.error("Error opening diff view:", error);
    }
  }

  /**
   * Apply pending changes to the workspace.
   */
  async applyPendingChanges() {
    for (const change of this.pendingChanges) {
      const { filePath, action, after } = change;
      await writeFile(filePath, after);
      console.log(`Applied ${action} to ${filePath}`);
    }
    vscode.window.showInformationMessage("All changes have been applied.");
    // Clear pending changes after applying
    this.pendingChanges = [];
  }
}

module.exports = {
    XmlToCodeViewProvider
  };