node-red-contrib-mcprotocol
===========================

## About

### Overview
This is a Node-RED node module to directly interface with MITSUBISHI PLCs over Ethernet using MC Protocol. 

### Features
- Both TCP and UDP connections are possible
- frames 1E, 3E and 4E are possible
- works for PLC types
  - A *(See Note 1)*
  - QnA
  - Q
  - L
  - R
- ASCII and BINARY mode *(See Note 2)*

### Recommendation
If your PLC suports UDP + 4E, this is by far most reliable. 

### NOTES
1. For A series PLC, only 1E frames are supported
2. ASCII mode is currently not supported for frames 3E and 4E
---
## Install

### Prerequisites

* node.js	(runtime for Node-RED)
* Node-RED
* [optional] git (Used for repository cloning/downloads)

### Easy install

Use the Manage Palette > Install option from the menu inside node-red


### NPM install
```sh
cd ~/.node-red
npm install node-red-contrib-mcprotocol
```

### GIT install Direct
```sh
cd ~/.node-red
npm install Steve-Mcl/node-red-contrib-mcprotocol
```

### GIT Install
Make a directory for the base files on the disk (somewhere secure) and open the created folder and open PowerShell (SHIFT + right_click) or "Git Bash Here" with right mouse inside the folder. Now enter the following:
```sh
cd c:/tempsourcefolder
git clone https://github.com/Steve-Mcl/node-red-contrib-mcprotocol.git

cd ~/.node-red
npm install c:/tempsourcefolder/node-red-contrib-mcprotocol
```

---

### Credits
* [plcpeople](https://github.com/plcpeople/mcprotocol) for the original implementation of mcprotocol
