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
            console.log('Received copyFileTreeOutput payload:', message.payload);
            const { instructions, selectedItems, selectedFiles } = message.payload;
            // Use selectedItems if available (new format), otherwise fall back to selectedFiles (old format)
            const selectedData = selectedItems || selectedFiles;
            console.log('Processing selected data:', selectedData);
            await this.copyFileTreeAsXml(instructions, selectedData);
            webviewView.webview.postMessage({ command: "fileTreeOutputCopied" });
          } catch (err) {
            console.error('Error in copyFileTreeOutput:', err);
            vscode.window.showErrorMessage("Error copying file tree output: " + err.message);
          }
          break;
        case "selectedFiles":
          // This is handled by the promise in copyFileTreeAsXml
          // No need to do anything here
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
      
      // Create a directory structure
      const fileTree = [];
      const directoryMap = {};
      
      // Process each file and organize into directory structure
      files.forEach(file => {
        const relativePath = vscode.workspace.asRelativePath(file);
        const pathParts = relativePath.split('/');
        const fileName = pathParts.pop();
        const isDirectory = false; // This is a file, not a directory
        
        // Create the file object
        const fileObj = {
          path: relativePath,
          name: fileName,
          isDirectory,
          selected: true, // Set all files to be selected by default
          expanded: false // Not applicable for files
        };
        
        // If it's a top-level file, add it directly to the file tree
        if (pathParts.length === 0) {
          fileTree.push(fileObj);
          return;
        }
        
        // Create directory structure
        let currentPath = '';
        let currentArray = fileTree;
        
        for (let i = 0; i < pathParts.length; i++) {
          const part = pathParts[i];
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          
          // Check if directory already exists in the current level
          let dirObj = directoryMap[currentPath];
          
          if (!dirObj) {
            // Create new directory object
            dirObj = {
              path: currentPath,
              name: part,
              isDirectory: true,
              children: [],
              expanded: false, // Directories start collapsed
              selected: true // Directories are selected by default
            };
            
            // Add to the current level and update the map
            currentArray.push(dirObj);
            directoryMap[currentPath] = dirObj;
          }
          
          // Update current array to the children of this directory
          currentArray = dirObj.children;
        }
        
        // Add the file to the final directory's children
        currentArray.push(fileObj);
      });
      
      // Sort the file tree
      const sortTree = (items) => {
        // Sort directories first, then files, both alphabetically
        items.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
        
        // Sort children recursively
        items.forEach(item => {
          if (item.isDirectory && item.children) {
            sortTree(item.children);
          }
        });
        
        return items;
      };
      
      return sortTree(fileTree);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get file tree: ${err.message}`);
      return [];
    }
  }
  
  /**
   * Copy the selected files from the file tree as XML
   */
  async copyFileTreeAsXml(instructions, selectedFiles = []) {
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) return;
    
    try {
      // Use the selectedFiles passed directly from the webview
      // No need to request them separately anymore
      
      // Show loading state and disable button during processing
      this._view.webview.postMessage({ command: "processingStarted" });
      
      // Get all files in the workspace
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
      
      // Filter files based on selection
      // With the new directory structure, selectedFiles will contain both files and directories
      // We need to extract just the file paths from the selection
      const selectedFilePaths = selectedFiles
        .filter(item => !item.isDirectory) // Only include files, not directories
        .map(item => item.path);
      
      // If directories are selected, we need to include all files within those directories
      const selectedDirPaths = selectedFiles
        .filter(item => item.isDirectory)
        .map(item => item.path);
      
      console.log('Selected file paths:', selectedFilePaths);
      console.log('Selected directory paths:', selectedDirPaths);
      
      // Filter out binary files and large files that might cause issues
      const binaryFileExtensions = [
        '.pack', '.pack.gz', '.pack.old', '.gz', '.zip', '.jar', '.war', 
        '.ear', '.class', '.so', '.dll', '.exe', '.obj', '.o', '.a', '.lib', 
        '.pyc', '.pyo', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.tif', 
        '.tiff', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.ogg', '.wav', 
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
      ];
      
      const filesToInclude = (selectedFilePaths.length > 0 || selectedDirPaths.length > 0 ?
        files.filter(file => {
          const relativePath = vscode.workspace.asRelativePath(file);
          
          // Skip binary files
          if (binaryFileExtensions.some(ext => relativePath.endsWith(ext))) {
            console.log(`Skipping binary file: ${relativePath}`);
            return false;
          }
          
          // Include if the file itself is selected
          if (selectedFilePaths.includes(relativePath)) {
            return true;
          }
          
          // Include if the file is in a selected directory
          for (const dirPath of selectedDirPaths) {
            // Ensure we're matching a directory by checking if the relative path
            // starts with the directory path followed by a slash
            // or if it exactly matches the directory path (for files directly in the directory)
            if (relativePath === dirPath || 
                relativePath.startsWith(dirPath + '/') || 
                // Handle case where directory doesn't end with slash
                (dirPath.indexOf('/') !== -1 && relativePath.startsWith(dirPath))) {
              // Skip binary files even if they're in selected directories
              if (!binaryFileExtensions.some(ext => relativePath.endsWith(ext))) {
                console.log(`Including file ${relativePath} from directory ${dirPath}`);
                return true;
              }
            }
          }
          
          return false;
        }) :
        files.filter(file => {
          const relativePath = vscode.workspace.asRelativePath(file);
          return !binaryFileExtensions.some(ext => relativePath.endsWith(ext));
        })); // If no selection, include all non-binary files
        
      console.log(`Total files to include (after filtering): ${filesToInclude.length}`);
      
      // Initialize XML string
      let xml = '<changes>\n';
      
      // Set a maximum file size to include (5MB)
      const MAX_FILE_SIZE = 5 * 1024 * 1024;
      // Set a maximum XML size for clipboard (10MB)
      const MAX_XML_SIZE = 10 * 1024 * 1024;
      
      // Batch process files in chunks of 50
      const batchSize = 50;
      const totalFiles = filesToInclude.length;
      let totalXmlSize = 0;
      let skippedFiles = 0;
      
      // Process files in batches with progress updates
      for (let i = 0; i < totalFiles; i += batchSize) {
        const batch = filesToInclude.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async file => {
          try {
            const relativePath = vscode.workspace.asRelativePath(file);
            
            // Check file size before reading content
            const fileStats = await vscode.workspace.fs.stat(file);
            if (fileStats.size > MAX_FILE_SIZE) {
              console.log(`Skipping large file (${fileStats.size} bytes): ${relativePath}`);
              skippedFiles++;
              return `  <!-- Skipped large file: ${relativePath} (${Math.round(fileStats.size / 1024)} KB) -->\n`;
            }
            
            const content = await getFileContentFromUri(file);
            const fileXml = `  <file path="${relativePath}" action="rewrite">\n    <change>\n      <description>File content</description>\n      <content>===\n${content}\n===</content>\n    </change>\n  </file>\n`;
            
            // Check if adding this file would exceed the maximum XML size
            if (totalXmlSize + fileXml.length > MAX_XML_SIZE) {
              console.log(`XML size limit reached, skipping file: ${relativePath}`);
              skippedFiles++;
              return `  <!-- Skipped file to keep XML size manageable: ${relativePath} -->\n`;
            }
            
            totalXmlSize += fileXml.length;
            return fileXml;
          } catch (err) {
            console.error(`Error processing file ${file.fsPath}:`, err);
            skippedFiles++;
            return `  <!-- Error processing file: ${vscode.workspace.asRelativePath(file)} -->\n`;
          }
        }));
        
        // Add batch results to XML
        xml += batchResults.join('');
        
        // Update progress every batch
        this._view.webview.postMessage({
          command: "processingProgress",
          payload: { processed: Math.min(i + batchSize, totalFiles), total: totalFiles }
        });
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to event loop
      }

      xml += `## Final Notes
1.  **rewrite**  For rewriting an entire file, place all new content in \`<content>\`. No partial modifications are possible here. Avoid all use of placeholders.
2. You can always **create** new files and **delete** existing files. Provide full code for create, and empty content for delete. Avoid creating files you know exist already.
3. If a file tree is provided, place your files logically within that structure. Respect the user’s relative or absolute paths.
4. Wrap your final output in \`\`\`XML ... \`\`\` for clarity.
5. **Important:** Do not wrap any XML output in CDATA tags (i.e. \`<![CDATA[ ... ]]>\`). Repo Prompt expects raw XML exactly as shown in the examples.
6. The final output must apply cleanly with no leftover syntax errors.
</xml_formatting_instructions>`;

      // Add instructions if provided (at the bottom of the XML)
      if (instructions) {
        xml += `  <user_instructions>\n    ${instructions}\n  </user_instructions>\n`;
      }
      
      xml += `</changes>`;
      
      await vscode.env.clipboard.writeText(xml);
      this._view.webview.postMessage({ command: "processingComplete" });
      vscode.window.showInformationMessage(`Copied ${filesToInclude.length} files to clipboard`);
      console.log(`Copied ${filesToInclude.length} files to clipboard`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to copy file tree as XML: ${err.message}`);
    }
  }
}

module.exports = {
  XmlToCodeViewProvider
};