# vibe coding

Easily create code changes from LLM outputs with a streamlined workflow

## Features

- **File Tree Exploration:** Select files from your workspace to include in context for your AI.
- **XML Generation:** Generate structured XML of selected files to send to your LLM.
- **Code Application:** Apply code changes received from your LLM with a preview of what will change.
- **Diff Viewer:** Preview differences before applying changes to ensure accuracy.

---

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/Timvdv/xml-to-code
   ```

2. **Navigate to the Extension Directory:**

   ```bash
   cd xml-to-code
   ```

3. **Install Dependencies:**

   ```bash
   npm install
   ```

4. **Open in VS Code:**

   ```bash
   code .
   ```

5. **Launch the Extension:**
   Press `F5` to open a new VS Code window with the extension loaded.

---

## Usage

1. **Open Vibe Coding View:**

   - Click on the **Vibe Coding** icon in the activity bar.
   - Alternatively, use the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac) and execute `Open Vibe Coding View`.

2. **Step 1: Select Files**
   
   - On the File Tree tab, select the files you want your LLM to understand.
   - Add any specific instructions in the text area.
   - Click **Copy XML Output** to copy the file tree as XML.
   - Paste this into your LLM along with your coding request.

3. **Step 2: Apply Changes**

   - After receiving the response from your LLM, go to the XML Input tab.
   - Paste the XML response from your LLM into the text area.
   - Click **Prepare Changes** to parse the XML and generate a list of pending code changes.
   - Review the listed changes and click **Apply Changes** to execute them.

---

## Example Workflow

1. **Select relevant files** in the File Tree tab
2. **Copy the XML output** and send to your LLM with instructions like:
   "Please modify the login functionality to include email validation"
3. **Copy the XML response** from your LLM
4. **Paste the response** in the XML Input tab
5. **Review and apply** the changes

---

## Example

```xml
<file path="src/components/MyComponent.js" action="rewrite">
  <change>
    <description>Add new state management logic to MyComponent</description>
    <content>
===
import React, { useState } from 'react';

const MyComponent = () => {
  const [state, setState] = useState(null);

  // New state management logic
  const updateState = (newState) => {
    setState(newState);
  };

  return (
    <div>
      {/* Component JSX */}
    </div>
  );
};

export default MyComponent;
===
    </content>
  </change>
</file>
```

---

## Testing

Run the test suite to ensure the extension functions as expected:

```bash
npm test
```

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

---

Made to use together with:

- [RepoPrompt](https://repoprompt.com)\
  Use the **XML Whole** prompt for best results.

Extension is made with ❤️ by Tim van de Vathorst\
[GitHub](https://github.com/Timvdv/xml-to-code) | [Donate](https://www.paypal.me/timvandevathorst)

