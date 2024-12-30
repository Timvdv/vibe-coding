"use strict";

const vscode = require("vscode");

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

module.exports = {
  writeFile
};
