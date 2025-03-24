(function () {
    console.log("Embedded webview.js has been loaded.");

    // Acquire the VS Code API
    const vscode = acquireVsCodeApi();

    // Keep track of the changes in a global array so we can handle checkboxes
    let globalChanges = [];

    // Get references to DOM elements
    const prepareChangesButton = document.getElementById('prepareChanges');
    const applyChangesButton = document.getElementById('applyChanges');
    const cancelChangesButton = document.getElementById('cancelChanges');
    const xmlInput = document.getElementById('xmlInput');
    const changesContainer = document.getElementById('changesContainer');
    const statusMessage = document.getElementById('statusMessage');
    const successMessage = document.getElementById('successMessage');
    const fixedButtonContainer = document.querySelector('.fixed-button-container');
    
    // Tab navigation elements
    const tabXmlInput = document.getElementById('tabXmlInput');
    const tabFileTree = document.getElementById('tabFileTree');
    const xmlInputTab = document.getElementById('xmlInputTab');
    const fileTreeTab = document.getElementById('fileTreeTab');
    const fileTreeList = document.getElementById('fileTreeList');
    const instructionsTextarea = document.getElementById('instructions');
    const copyOutputButton = document.getElementById('copyOutput');

    // Collapsible input section and toggle button
    const inputSection = document.getElementById('inputSection');
    const toggleInputBtn = document.getElementById('toggleInputBtn');
    let inputCollapsed = false;

    // Ensure "Apply Changes" button is hidden on initial load
    fixedButtonContainer.style.display = 'none';

    // When user clicks "Prepare Changes"
    prepareChangesButton.addEventListener('click', () => {
        const xml = xmlInput.value.trim();
        if (!xml) {
            statusMessage.textContent = "Please enter XML input.";
            statusMessage.style.color = "red";
            return;
        }
        statusMessage.textContent = "";
        vscode.postMessage({
            command: 'applyXml',
            payload: xml
        });
        console.log("Sent 'applyXml' message to extension.");
    });

    // When user clicks "Apply Changes"
    applyChangesButton.addEventListener('click', () => {
        // Collect the indices of changes that are still selected
        const selectedIndexes = globalChanges
            .filter(change => change.selected)
            .map(change => change.index);

        vscode.postMessage({
            command: 'confirmApply',
            payload: { selectedIndexes }
        });
        console.log("Sent 'confirmApply' message to extension with selectedIndexes:", selectedIndexes);
    });

    cancelChangesButton.addEventListener('click', () => {
        const confirmCancel = confirm("Are you sure you want to cancel? All changes will be deleted.");
        if (confirmCancel) {
            vscode.postMessage({
                command: 'cancelChanges'
            });
        }
    });

    // Toggle button to show/hide the XML input area
    toggleInputBtn.addEventListener('click', () => {
        inputCollapsed = !inputCollapsed;
        if (inputCollapsed) {
            // Collapse
            inputSection.classList.remove('expanded');
            inputSection.classList.add('collapsed');
            toggleInputBtn.textContent = 'Show XML';
        } else {
            // Expand
            inputSection.classList.remove('collapsed');
            inputSection.classList.add('expanded');
            toggleInputBtn.textContent = 'Hide XML';
        }
    });
    
    // Tab switching functionality
    tabXmlInput.addEventListener('click', () => {
        // Switch to XML Input tab
        tabXmlInput.classList.add('active');
        tabFileTree.classList.remove('active');
        xmlInputTab.classList.add('active');
        fileTreeTab.classList.remove('active');
    });
    
    tabFileTree.addEventListener('click', () => {
        // Switch to File Tree tab
        tabFileTree.classList.add('active');
        tabXmlInput.classList.remove('active');
        fileTreeTab.classList.add('active');
        xmlInputTab.classList.remove('active');
        
        // Request file tree data from extension
        vscode.postMessage({
            command: 'getFileTree'
        });
    });
    
    // Copy Output button functionality
    copyOutputButton.addEventListener('click', () => {
        const instructions = instructionsTextarea.value.trim();
        vscode.postMessage({
            command: 'copyFileTreeOutput',
            payload: { instructions }
        });
    });

    // Listen for messages from the extension
    window.addEventListener('message', event => {
        const message = event.data;
        console.log("Received message from extension:", message);
        switch (message.command) {
            case 'displayChanges':
                displayChanges(message.payload);
                successMessage.style.display = 'none';
                // Show the fixed Apply Changes button only if there's at least one change
                if (message.payload.length > 0) {
                    fixedButtonContainer.style.display = 'block';
                } else {
                    fixedButtonContainer.style.display = 'none';
                }
                // Automatically collapse the input section when changes are displayed
                if (message.payload.length > 0) {
                  inputSection.classList.remove('expanded');
                  inputSection.classList.add('collapsed');
                  inputCollapsed = true;
                  toggleInputBtn.style.display = 'inline-block'; // Show the toggle button
                  toggleInputBtn.textContent = 'Show XML'; // Because we've just collapsed it
                }
                break;

            case 'changesApplied':
                successMessage.classList.add('visible');
                fixedButtonContainer.style.display = 'none';
                clearChanges();

                // Expand the input section again
                inputSection.classList.remove('collapsed');
                inputSection.classList.add('expanded');
                // Hide toggle button (reset state)
                toggleInputBtn.style.display = 'none';
                // Clear the text field
                xmlInput.value = "";
                inputCollapsed = false;
                break;

            case 'clearChanges':
                clearChanges();
                fixedButtonContainer.style.display = 'none';
                break;

            case 'cancelChanges':
                clearChanges();
                fixedButtonContainer.style.display = 'none';
                inputSection.classList.remove('collapsed');
                inputSection.classList.add('expanded');
                toggleInputBtn.style.display = 'none';
                xmlInput.value = "";
                successMessage.style.display = 'none';
                break;
                
            case 'displayFileTree':
                displayFileTree(message.payload);
                break;
                
            case 'fileTreeOutputCopied':
                vscode.window.showInformationMessage('File tree XML output copied to clipboard!');
                break;

            default:
                console.warn("Unknown command:", message.command);
        }
    });

    // Display pending changes in the UI
    function displayChanges(changes) {
        changesContainer.innerHTML = ''; // Clear previous changes
        globalChanges = []; // Reset the global array

        if (changes.length === 0) {
            changesContainer.textContent = "No changes to display.";
            return;
        }

        const list = document.createElement('ul');
        list.className = 'file-list';

        changes.forEach((change, index) => {
            // Each change in global array, default selected to true
            globalChanges.push({
                ...change,
                index: index,
                selected: true
            });

            const listItem = document.createElement('li');
            listItem.className = 'file-item';

            // If this is a "delete" action, highlight with .delete-item
            if (change.action === 'delete') {
                listItem.classList.add('delete-item');
            }

            // File path element
            const filePath = document.createElement('div');
            filePath.className = 'file-path';
            filePath.textContent = change.filePath;

            // Description element
            const description = document.createElement('div');
            description.className = 'file-description';
            description.textContent = `${change.action.toUpperCase()}: ${change.description}`;

            // Checkbox
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'change-checkbox';
            checkbox.checked = true;
            checkbox.addEventListener('click', (evt) => {
                evt.stopPropagation(); // don’t open diff
                globalChanges[index].selected = evt.target.checked;
            });

            listItem.appendChild(filePath);
            listItem.appendChild(description);
            listItem.appendChild(checkbox);

            // Clicking the listItem (except for checkbox) triggers diff
            listItem.addEventListener('click', (evt) => {
                if (evt.target === checkbox) {
                    return; // ignore clicks on the checkbox itself
                }
                vscode.postMessage({
                    command: 'viewDiff',
                    payload: { index }
                });
            });

            list.appendChild(listItem);
        });

        changesContainer.appendChild(list);
    }

    // Clear changes from the UI
    function clearChanges() {
        changesContainer.innerHTML = '';
        globalChanges = [];
        successMessage.classList.remove('visible');
    }
    
    // Display file tree in the UI
    function displayFileTree(files) {
        fileTreeList.innerHTML = ''; // Clear previous file tree
        
        if (!files || files.length === 0) {
            fileTreeList.textContent = "No files to display.";
            return;
        }
        
        const list = document.createElement('ul');
        list.className = 'file-list';
        
        files.forEach((file, index) => {
            const listItem = document.createElement('li');
            listItem.className = 'file-item';
            
            // File path element
            const filePath = document.createElement('div');
            filePath.className = 'file-path';
            filePath.textContent = file.path;
            
            // Checkbox for selection
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'change-checkbox';
            checkbox.checked = file.selected || false;
            checkbox.addEventListener('click', (evt) => {
                evt.stopPropagation(); // don't trigger the listItem click
                file.selected = evt.target.checked;
            });
            
            listItem.appendChild(filePath);
            listItem.appendChild(checkbox);
            
            // Make the list item clickable
            listItem.addEventListener('click', (evt) => {
                if (evt.target === checkbox) {
                    return; // ignore clicks on the checkbox itself
                }
                // Toggle selection
                checkbox.checked = !checkbox.checked;
                file.selected = checkbox.checked;
            });
            
            list.appendChild(listItem);
        });
        
        fileTreeList.appendChild(list);
    }
})();