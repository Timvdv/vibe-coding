"use strict";

const vscode = require("vscode");

/**
 * Writes (or overwrites) the given file with the provided content.
 */
const path = require('path');

async function writeFile(filePath, content) {
  if (!vscode.workspace?.workspaceFolders?.length) {
    vscode.window.showErrorMessage("No workspace folder is open.");
    console.error("writeFile called but no workspace folder is open.");
    return;
  }

  const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
  const fileUri = vscode.Uri.joinPath(workspaceUri, filePath);

  // Extract directory path from filePath
  const dirPath = path.dirname(fileUri.fsPath);

  try {
    // Ensure the directory exists
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));

    const encoder = new TextEncoder();
    const fileData = encoder.encode(content);
    await vscode.workspace.fs.writeFile(fileUri, fileData);
    console.log(`File written successfully: ${filePath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to write file: ${filePath}`);
    console.error(`Error writing file ${filePath}:`, error);
  }
}

module.exports = {
  writeFile
};
