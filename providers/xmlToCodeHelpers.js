"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

// Converts ===...=== blocks within <content> tags to CDATA sections.
function convertTripleEqualsToCdata(xmlString) {
  const contentRegex = /<content\b[^>]*>([\s\S]*?)<\/content>/gi;
  return xmlString.replace(contentRegex, (match, inside) => {
    const firstIdx = inside.indexOf("===");
    const lastIdx = inside.lastIndexOf("===");
    if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
      const before = inside.substring(0, firstIdx);
      const code = inside.substring(firstIdx + 3, lastIdx);
      const after = inside.substring(lastIdx + 3);
      return `<content><![CDATA[${code}]]></content>`;
    }
    return match;
  });
}

// Generates a random nonce string of 32 characters.
function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Normalizes a file path to ensure consistency.
function normalizeFilePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }
  if (!filePath.startsWith("./") && !filePath.startsWith("../")) {
    filePath = `./${filePath}`;
  }
  return path.normalize(filePath);
}

// Retrieves the workspace URI; shows an error if none is open.
function getWorkspaceUri() {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0].uri;
  }
  vscode.window.showErrorMessage("No workspace folder is open.");
  return null;
}

// Resolves the file URI based on whether the filePath is absolute or relative.
function getFileUri(workspaceUri, filePath) {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  return vscode.Uri.joinPath(workspaceUri, filePath);
}

// Reads and decodes file content from a given file URI.
async function getFileContentFromUri(fileUri) {
  try {
    const fileData = await vscode.workspace.fs.readFile(fileUri);
    return new TextDecoder().decode(fileData);
  } catch (err) {
    return "";
  }
}

// Retrieves file content given a file path.
async function getFileContent(filePath) {
  try {
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) return "";
    const fileUri = getFileUri(workspaceUri, filePath);
    return await getFileContentFromUri(fileUri);
  } catch (err) {
    return "";
  }
}

module.exports = {
  convertTripleEqualsToCdata,
  getNonce,
  normalizeFilePath,
  getWorkspaceUri,
  getFileUri,
  getFileContentFromUri,
  getFileContent
};