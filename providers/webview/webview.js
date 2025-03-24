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
    const toggleSelectAllButton = document.getElementById('toggleSelectAll');

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
    copyOutputButton.addEventListener('click', async () => {
        const instructions = document.getElementById('instructions').value;
        const selectedItems = [];
        
        console.log('Starting selected items collection');
        
        // Collect all checked checkboxes
        const checkedBoxes = document.querySelectorAll('#fileTreeList input[type="checkbox"]:checked');
        console.log('Found checked checkboxes:', checkedBoxes.length);
    
        checkedBoxes.forEach(checkbox => {
            const itemContainer = checkbox.closest('.item-container');
            if (itemContainer) {
                const path = itemContainer.getAttribute('data-path');
                const listItem = itemContainer.closest('li');
                const isDirectory = listItem && listItem.classList.contains('directory-item');
                
                console.log('Processing checked item:', path);
                if (path) {
                    selectedItems.push({
                        path: path,
                        isDirectory: isDirectory,
                        checked: checkbox.checked
                    });
                }
            }
        });
    
        console.log('Collected selected items:', selectedItems);
        
        vscode.postMessage({
            command: 'copyFileTreeOutput',
            payload: { instructions, selectedItems }
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
                // Use alert instead of vscode.window.showInformationMessage which isn't available in webview context
                alert('File tree XML output copied to clipboard!');
                break;
                
            case 'getSelectedFiles':
                // Collect all selected files and send them back to the extension
                const selectedFiles = Array.from(document.querySelectorAll('#fileTreeList .file-item input:checked'))
                    .map(checkbox => {
                        const fileItem = checkbox.closest('.file-item');
                        const filePath = fileItem.querySelector('.file-path').textContent;
                        return { path: filePath, selected: true };
                    });
                
                vscode.postMessage({
                    command: 'selectedFiles',
                    payload: selectedFiles
                });
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
    
    // Toggle Select All / Deselect All functionality
    toggleSelectAllButton.addEventListener('click', () => {
        // Determine current state (if any items are selected)
        const allCheckboxes = document.querySelectorAll('#fileTreeList input[type="checkbox"]');
        const anySelected = Array.from(allCheckboxes).some(checkbox => checkbox.checked);
        
        // Toggle all checkboxes to the opposite state
        const newState = !anySelected;
        allCheckboxes.forEach(checkbox => {
            checkbox.checked = newState;
            
            // Get the item path from the parent container
            const itemContainer = checkbox.closest('.item-container');
            if (itemContainer) {
                const path = itemContainer.getAttribute('data-path');
                if (path) {
                    window.fileTreeSelection[path] = newState;
                }
            }
        });
        
        // Update button text
        toggleSelectAllButton.textContent = newState ? 'Deselect All' : 'Select All';
    });

    // Display file tree in the UI
    function displayFileTree(files) {
        fileTreeList.innerHTML = ''; // Clear previous file tree
        
        if (!files || files.length === 0) {
            fileTreeList.textContent = "No files to display.";
            return;
        }
        
        // Store file selection state globally
        window.fileTreeSelection = window.fileTreeSelection || {};
        
        // Create the root list
        const rootList = document.createElement('ul');
        rootList.className = 'file-list';
        fileTreeList.appendChild(rootList);
        
        // Reset the Select All button text based on initial selection state
        if (toggleSelectAllButton) {
            toggleSelectAllButton.textContent = 'Select All';
        }
        
        // Recursive function to render the file tree
        function renderTree(items, parentElement) {
            items.forEach((item) => {
                const listItem = document.createElement('li');
                listItem.className = item.isDirectory ? 'directory-item' : 'file-item';
                
                // Create the item container
                const itemContainer = document.createElement('div');
                itemContainer.className = 'item-container';
                
                // Check if we have a saved selection state for this item
                const savedSelectionState = window.fileTreeSelection[item.path];
                const isSelected = savedSelectionState !== undefined ? 
                    savedSelectionState : (item.selected || false);
                
                // Save the initial selection state
                window.fileTreeSelection[item.path] = isSelected;
                
                // Create expand/collapse icon for directories
                if (item.isDirectory) {
                    const expandIcon = document.createElement('span');
                    expandIcon.className = 'expand-icon';
                    expandIcon.textContent = item.expanded ? '▼' : '►';
                    expandIcon.addEventListener('click', (evt) => {
                        evt.stopPropagation();
                        // Toggle expanded state
                        item.expanded = !item.expanded;
                        expandIcon.textContent = item.expanded ? '▼' : '►';
                        
                        // Show/hide children
                        const childrenContainer = listItem.querySelector('.children-container');
                        if (childrenContainer) {
                            childrenContainer.style.display = item.expanded ? 'block' : 'none';
                        }
                    });
                    itemContainer.appendChild(expandIcon);
                } else {
                    // Add spacing for files to align with directories
                    const spacer = document.createElement('span');
                    spacer.className = 'file-spacer';
                    spacer.textContent = '  ';
                    itemContainer.appendChild(spacer);
                }
                
                // Item name/path element
                const itemText = document.createElement('div');
                itemText.className = item.isDirectory ? 'directory-name' : 'file-path';
                itemText.textContent = item.name;
                itemContainer.appendChild(itemText);
                
                // Checkbox for selection
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'change-checkbox';
                checkbox.checked = isSelected;
                checkbox.addEventListener('click', (evt) => {
                    evt.stopPropagation(); // don't trigger the listItem click
                    
                    // Update selection state
                    item.selected = evt.target.checked;
                    window.fileTreeSelection[item.path] = evt.target.checked;
                    
                    // If it's a directory, select/deselect all children
                    if (item.isDirectory && item.children) {
                        const updateChildrenSelection = (children, selected) => {
                            children.forEach(child => {
                                child.selected = selected;
                                window.fileTreeSelection[child.path] = selected;
                                
                                // Update checkbox if it's rendered
                                const childCheckbox = listItem.querySelector(`[data-path="${child.path}"] input[type="checkbox"]`);
                                if (childCheckbox) {
                                    childCheckbox.checked = selected;
                                }
                                
                                // Recursively update children of directories
                                if (child.isDirectory && child.children) {
                                    updateChildrenSelection(child.children, selected);
                                }
                            });
                        };
                        
                        updateChildrenSelection(item.children, evt.target.checked);
                        
                        // Re-render the children to update checkboxes
                        if (item.expanded) {
                            const childrenContainer = listItem.querySelector('.children-container');
                            if (childrenContainer) {
                                childrenContainer.innerHTML = '';
                                const childList = document.createElement('ul');
                                childrenContainer.appendChild(childList);
                                renderTree(item.children, childList);
                            }
                        }
                    }
                });
                itemContainer.appendChild(checkbox);
                
                // Set a data attribute for easier selection
                itemContainer.setAttribute('data-path', item.path);
                listItem.appendChild(itemContainer);
                
                // Make the item container clickable (except for checkbox)
                itemContainer.addEventListener('click', (evt) => {
                    if (evt.target === checkbox || evt.target.className === 'expand-icon') {
                        return; // ignore clicks on the checkbox or expand icon
                    }
                    
                    // For directories, toggle expand/collapse
                    if (item.isDirectory) {
                        item.expanded = !item.expanded;
                        const expandIcon = itemContainer.querySelector('.expand-icon');
                        if (expandIcon) {
                            expandIcon.textContent = item.expanded ? '▼' : '►';
                        }
                        
                        // Show/hide children
                        const childrenContainer = listItem.querySelector('.children-container');
                        if (childrenContainer) {
                            childrenContainer.style.display = item.expanded ? 'block' : 'none';
                        }
                    } else {
                        // For files, toggle selection
                        checkbox.checked = !checkbox.checked;
                        item.selected = checkbox.checked;
                        window.fileTreeSelection[item.path] = checkbox.checked;
                    }
                });
                
                // Add children container for directories
                if (item.isDirectory && item.children) {
                    const childrenContainer = document.createElement('div');
                    childrenContainer.className = 'children-container';
                    childrenContainer.style.display = item.expanded ? 'block' : 'none';
                    
                    const childList = document.createElement('ul');
                    childrenContainer.appendChild(childList);
                    listItem.appendChild(childrenContainer);
                    
                    // Always render children, but control visibility with display property
                    renderTree(item.children, childList);
                    
                    // Set initial expanded state for all children
                    item.children.forEach(child => {
                        if (child.isDirectory) {
                            child.expanded = false;
                        }
                    });
                }
                
                parentElement.appendChild(listItem);
            });
        }
        
        // Start rendering from the root
        renderTree(files, rootList);
    }
})();