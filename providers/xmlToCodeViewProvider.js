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
    this.viewId = "vibeCodingView";
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
            await vscode.commands.executeCommand("vibeCoding.previewChanges");
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
          webviewView.webview.postMessage({ command: "cancelChanges" });
          break;
        case "getFileTree":
          try {
            const { tree, biggestFiles } = await this.getWorkspaceFileTree();
            webviewView.webview.postMessage({
              command: "displayFileTree",
              payload: {
                tree,
                biggestFiles
              }
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

    // Convert triple-equals blocks to CDATA
    let processedXml = convertTripleEqualsToCdata(xmlInput);
    
    // Check if the XML already has a <changes> root element
    const hasChangesRoot = /<\s*changes\b[^>]*>/.test(processedXml.trim());
    
    if (!hasChangesRoot) {
      // More robust check for any root element
      const hasRootTag = /<\s*[\w-]+[^>]*>/.test(processedXml.trim());
      
      if (!hasRootTag) {
        // Only wrap with <changes> if there's no root element
        processedXml = `<changes>${processedXml}</changes>`;
        console.log("Added <changes> wrapper to XML input");
      } else {
        // Check specifically for <file> at the root level without a wrapper
        const startsWithFileTag = /^\s*<\s*file\b/.test(processedXml.trim());
        if (startsWithFileTag) {
          processedXml = `<changes>${processedXml}</changes>`;
          console.log("Added <changes> wrapper to XML with root <file> tags");
        } else {
          console.log("Using XML input with existing root element");
        }
      }
    } else {
      console.log("XML already has <changes> root element");
    }
    
    console.log("Processed XML after wrapping:", processedXml.substring(0, 200) + "...");

    let xmlDoc;
    try {
      const parser = new DOMParser({
        errorHandler: {
          warning: (msg) => {
            console.warn("XML Parser Warning:", msg);
          },
          error: (msg) => {
            console.error("XML Parser Error:", msg);
          },
          fatalError: (msg) => {
            console.error("XML Parser Fatal Error:", msg);
          },
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
      return;
    }

    for (let i = 0; i < fileNodes.length; i++) {
      const fileNode = fileNodes.item(i);
      let filePath = fileNode.getAttribute("path");
      let action = fileNode.getAttribute("action");
      
      console.log(`Processing file node ${i+1}/${fileNodes.length}: path=${filePath}, action=${action}`);
      
      if (!filePath || !action) {
        console.log(`Skipping file node ${i+1} due to missing path or action`);
        continue;
      }

      filePath = normalizeFilePath(filePath);
      const changeNodes = fileNode.getElementsByTagName("change");
      console.log(`Found ${changeNodes.length} change nodes for file ${filePath}`);

      if (action === "delete") {
        const beforeContent = await this.getBeforeContent(filePath);
        this.pendingChanges.push({
          filePath,
          action: "delete",
          description: `Delete file ${filePath}`,
          before: beforeContent,
          after: "",
        });
        console.log(`Added delete action for ${filePath}`);
      } else {
        if (changeNodes.length === 0) {
          // Handle files with no change nodes but with create/rewrite action
          if (action === "create" || action === "rewrite") {
            const beforeContent = action === "rewrite" ? await getFileContent(filePath) : "";
            this.pendingChanges.push({
              filePath,
              action,
              description: `${action === "create" ? "Create" : "Rewrite"} file ${filePath}`,
              before: beforeContent,
              after: "",  // Empty content
            });
            console.log(`Added ${action} action for ${filePath} with no content`);
          }
          continue;
        }
        
        for (let j = 0; j < changeNodes.length; j++) {
          const changeNode = changeNodes.item(j);
          const descNodes = changeNode.getElementsByTagName("description");
          let description = "";
          if (descNodes && descNodes.length > 0) {
            description = descNodes.item(0).textContent.trim();
          }
          const contentNodes = changeNode.getElementsByTagName("content");
          
          console.log(`Processing change ${j+1} for ${filePath}, description: "${description}"`);
          console.log(`Content nodes found: ${contentNodes ? contentNodes.length : 0}`);
          
          if (!contentNodes || !contentNodes.length) {
            console.log(`No content nodes found for change ${j+1}, skipping`);
            continue;
          }
          
          let rawCode = contentNodes.item(0).textContent;
          if (rawCode) {
            rawCode = rawCode.trim();
            console.log(`Extracted content of length: ${rawCode.length} chars`);
          } else {
            console.log(`Warning: Empty content extracted for change ${j+1}`);
          }

          if (action === "rewrite" && !rawCode) {
            const beforeContent = await this.getBeforeContent(filePath);
            this.pendingChanges.push({
              filePath,
              action: "delete",
              description: `Delete file ${filePath}`,
              before: beforeContent,
              after: "",
            });
            console.log(`Added delete action for ${filePath} due to empty rewrite content`);
            continue;
          }

          if (action === "create" || action === "rewrite") {
            const beforeContent = action === "rewrite" ? await getFileContent(filePath) : "";
            this.pendingChanges.push({
              filePath,
              action,
              description: description || `${action === "create" ? "Create" : "Rewrite"} file ${filePath}`,
              before: beforeContent,
              after: rawCode,
            });
            console.log(`Added ${action} action for ${filePath}, content length: ${rawCode.length}`);
          } else {
            console.log(`Unrecognized action "${action}" for file ${filePath}`);
          }
        }
      }
    }

    if (this.pendingChanges.length === 0) {
      console.log("Warning: No valid changes were parsed from the XML. Raw XML length:", xmlInput.length);
      console.log("XML preview (first 100 chars):", xmlInput.substring(0, 100));
      vscode.window.showWarningMessage("No valid changes were parsed from the XML. Check the developer console for details.");
      return;
    }
    console.log(`Successfully prepared ${this.pendingChanges.length} changes from XML input`);
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
    
    // Load and parse .gitignore file if it exists
    const ignore = require('ignore');
    const ig = ignore();
    
    try {
      const gitignorePath = vscode.Uri.joinPath(workspaceUri, '.gitignore');
      const gitignoreContent = await getFileContentFromUri(gitignorePath);
      ig.add(gitignoreContent);
    } catch (err) {
      // .gitignore file doesn't exist or can't be read, continue without it
      console.log('No .gitignore file found or unable to read it:', err.message);
    }
    
    try {
      // Get all files in the workspace
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
      
      // Create a directory structure
      const fileTree = [];
      const directoryMap = {};
      const biggestFiles = []; // Array to track the biggest files
      
      // Process each file and organize into directory structure
      for (const file of files) {
        // Skip files that match gitignore patterns
        const relativePath = vscode.workspace.asRelativePath(file);
        if (ig.ignores(relativePath)) {
          console.log(`Skipping ignored file: ${relativePath}`);
          continue;
        }
        
        // Get file size
        try {
          const stat = await vscode.workspace.fs.stat(file);
          const fileSize = stat.size;
          
          const pathParts = relativePath.split('/');
          const fileName = pathParts.pop();
          const isDirectory = false; // This is a file, not a directory
          
          // Create the file object
          const fileObj = {
            path: relativePath,
            name: fileName,
            isDirectory,
            selected: true, // Set all files to be selected by default
            expanded: false, // Not applicable for files
            size: fileSize // Add size property
          };
          
          // Track for biggest files list
          biggestFiles.push(fileObj);
          
          // If it's a top-level file, add it directly to the file tree
          if (pathParts.length === 0) {
            fileTree.push(fileObj);
            continue;
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
        } catch (error) {
          console.log(`Error getting size for file ${relativePath}:`, error);
        }
      }
      
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
      
      // Sort biggest files by size
      biggestFiles.sort((a, b) => b.size - a.size);
      
      // Take top 10 files
      const top10Files = biggestFiles.slice(0, 10);
      
      return {
        tree: sortTree(fileTree),
        biggestFiles: top10Files
      };
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get file tree: ${err.message}`);
      return { tree: [], biggestFiles: [] };
    }
  }
  
  /**
   * Copy the selected files from the file tree as XML
   */
  async copyFileTreeAsXml(instructions, selectedFiles = []) {
    const workspaceUri = getWorkspaceUri();
    if (!workspaceUri) return;
    
    try {
      // Show loading state and disable button during processing
      this._view.webview.postMessage({ command: "processingStarted" });
      
      // Load and parse .gitignore file if it exists
      const ignore = require('ignore');
      const ig = ignore();
      
      try {
        const gitignorePath = vscode.Uri.joinPath(workspaceUri, '.gitignore');
        const gitignoreContent = await getFileContentFromUri(gitignorePath);
        ig.add(gitignoreContent);
      } catch (err) {
        // .gitignore file doesn't exist or can't be read, continue without it
        console.log('No .gitignore file found or unable to read it:', err.message);
      }
      
      // Get all files in the workspace
      const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 10000);
      
      // Filter out gitignored files
      const filteredFiles = allFiles.filter(file => {
        const relativePath = vscode.workspace.asRelativePath(file);
        if (ig.ignores(relativePath)) {
          console.log(`Skipping ignored file in XML output: ${relativePath}`);
          return false;
        }
        return true;
      });
      
      // Filter files based on selection (for XML content only, not file map)
      const selectedFilePaths = selectedFiles
        .filter(item => !item.isDirectory)
        .map(item => item.path);
      
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
      
      // Generate file tree structure for the file map - files that aren't ignored
      const fileMapTree = {};
      const workspaceName = path.basename(workspaceUri.fsPath);
      
      // Build file tree structure for filtered files (for file map only)
      filteredFiles.forEach(file => {
        // Skip binary files from file map
        const relativePath = vscode.workspace.asRelativePath(file);
        if (binaryFileExtensions.some(ext => relativePath.endsWith(ext))) {
          return; // Skip binary files in file map
        }
        
        const pathParts = relativePath.split('/');
        
        let currentLevel = fileMapTree;
        for (let i = 0; i < pathParts.length; i++) {
          const part = pathParts[i];
          const isFile = i === pathParts.length - 1;
          
          if (isFile) {
            currentLevel[part] = null; // Files are represented as null (leaf nodes)
          } else {
            if (!currentLevel[part]) {
              currentLevel[part] = {}; // Create new directory
            }
            currentLevel = currentLevel[part]; // Go deeper into the directory
          }
        }
      });
      
      // Function to generate ASCII file map representation using simple ASCII characters
      function generateFileMap(tree, prefix = '', isLast = true) {
        let result = '';
        const entries = Object.entries(tree);
        
        entries.forEach(([key, value], index) => {
          const isLastItem = index === entries.length - 1;
          // Use simple ASCII characters that work in all environments
          const line = `${prefix}${isLastItem ? '`-- ' : '|-- '}${key}\n`;
          result += line;
          
          if (value !== null) {
            const newPrefix = prefix + (isLastItem ? '    ' : '|   ');
            result += generateFileMap(value, newPrefix, isLastItem);
          }
        });
        
        return result;
      }
      
      // Generate the file map string
      let fileMapString = `${workspaceName}\n`;
      fileMapString += generateFileMap(fileMapTree);
      
      // Initialize XML string with file map at the top
      let xml = '<changes>\n<file_map>\n';
      xml += fileMapString;
      xml += '</file_map>\n\n';
      
      // Filter the files for content inclusion based on selection
      const filesToInclude = (selectedFilePaths.length > 0 || selectedDirPaths.length > 0 ?
        filteredFiles.filter(file => {
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
            if (relativePath === dirPath || 
                relativePath.startsWith(dirPath + '/') || 
                (dirPath.indexOf('/') !== -1 && relativePath.startsWith(dirPath))) {
              if (!binaryFileExtensions.some(ext => relativePath.endsWith(ext))) {
                console.log(`Including file ${relativePath} from directory ${dirPath}`);
                return true;
              }
            }
          }
          
          return false;
        }) :
        filteredFiles.filter(file => {
          const relativePath = vscode.workspace.asRelativePath(file);
          return !binaryFileExtensions.some(ext => relativePath.endsWith(ext));
        }));
        
      console.log(`Total files to include in XML content (after filtering): ${filesToInclude.length}`);
      
      // Set a maximum file size to include (5MB)
      const MAX_FILE_SIZE = 5 * 1024 * 1024;
      
      // Batch process files in chunks of 50
      const batchSize = 50;
      const totalFiles = filesToInclude.length;
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
3. If a file tree is provided, place your files logically within that structure. Respect the user's relative or absolute paths.
4. Wrap your final output in \`\`\`XML ... \`\`\` for clarity.
5. **Important:** Do not wrap any XML output in CDATA tags (i.e. \`<![CDATA[ ... ]]>\`). Repo Prompt expects raw XML exactly as shown in the examples.
6. The final output must apply cleanly with no leftover syntax errors.
7. Try to not remove any code from the original file, unless it is absolutely necessary.
</xml_formatting_instructions>`;

      // Add instructions if provided (at the bottom of the XML)
      if (instructions) {
        xml += `  <user_instructions>\n    ${instructions}\n  </user_instructions>\n`;
      }
      
      xml += `</changes>`;
      
      // Write XML to a temporary file
      const tempDir = path.join(os.tmpdir(), 'xml-to-code');
      fs.mkdirSync(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, `clipboard-${Date.now()}.xml`);
      fs.writeFileSync(tempFile, xml, 'utf8');
      
      // Use native clipboard command based on OS
      let clipboardCommand;
      if (process.platform === 'darwin') {
        // macOS
        clipboardCommand = `cat "${tempFile}" | pbcopy`;
      } else if (process.platform === 'win32') {
        // Windows
        clipboardCommand = `type "${tempFile}" | clip`;
      } else {
        // Linux (requires xclip)
        clipboardCommand = `cat "${tempFile}" | xclip -selection clipboard`;
      }
      
      const { exec } = require('child_process');
      exec(clipboardCommand, (error) => {
        if (error) {
          console.error('Error using native clipboard:', error);
          // Fall back to VSCode clipboard for smaller content
          if (xml.length < 100000) {
            vscode.env.clipboard.writeText(xml).then(() => {
              this._view.webview.postMessage({ command: "processingComplete" });
              vscode.window.showInformationMessage(`Copied ${filesToInclude.length} files to clipboard`);
            });
          } else {
            this._view.webview.postMessage({ command: "processingComplete" });
            vscode.window.showErrorMessage(`Failed to copy to clipboard. XML content saved to ${tempFile}`);
          }
        } else {
          this._view.webview.postMessage({ command: "processingComplete" });
          vscode.window.showInformationMessage(`Copied ${filesToInclude.length} files to clipboard (using native clipboard)`);
          console.log(`Copied ${filesToInclude.length} files to clipboard using native clipboard command`);
          
          // Clean up temp file after a delay
          setTimeout(() => {
            try {
              fs.unlinkSync(tempFile);
            } catch (e) {
              console.error('Error cleaning up temp file:', e);
            }
          }, 5000);
        }
      });
      
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to copy file tree as XML: ${err.message}`);
      this._view.webview.postMessage({ command: "processingComplete" });
    }
  }
}

module.exports = {
  XmlToCodeViewProvider
};