# GitHub PR Status Notifier Extension

This Chrome extension changes the favicon of a GitHub pull request page to indicate the status of the pull request. The icon changes when the pull request is approved or merged.

![](images/demo.png)
> A screenshot of the GitHub PR Status Notifier Extension in action.


## Features

- Detects when a pull request is approved and changes the favicon to indicate approval.
- Detects when a pull request is merged and changes the favicon to indicate merging.
- Shows when an open pull request has review feedback waiting, other than your own: an unresolved review thread (outdated ones included), or a human's latest review that requested changes or commented with text after the newest commit. The tab shows the avatar of a human with feedback waiting, or an orange speech bubble when only bots (such as CodeRabbit) have unresolved threads. Either one overrides the approved icon.
- Reloads an open pull request's tab when one of its review threads is resolved, or one of its reviews or comments is hidden, somewhere other than that tab after the page loaded, since GitHub's page doesn't update for either. It also reloads the Conversation tab when someone else approves or requests changes, which GitHub's page doesn't show until reloaded either. It waits while any text box on the page holds text you haven't submitted.

## Installation

![](images/setup_demo.png)

1. Clone the repository or download the ZIP file.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable "Developer mode" by toggling the switch in the top right.
4. Click "Load unpacked" and select the directory containing the extension files.

## File Structure

```
my-extension/
├── content.js
├── images/
│   ├── approved_icon.png
│   ├── feedback_icon.png
│   ├── merged_icon.png
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── manifest.json
└── README.md
```

## Usage

1. After loading the extension, navigate to a GitHub pull request page.
2. When the pull request is approved, the favicon will change to the approved icon.
3. When the pull request is merged, the favicon will change to the merged icon.

## Contributing

Feel free to fork the repository and submit pull requests with enhancements or bug fixes.

## License

This project is licensed under the MIT License.
