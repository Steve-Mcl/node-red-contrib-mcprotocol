node-red-contrib-mcprotocol
===========================

### Overview
This is a Node-RED node module to directly interface with MITSUBISHI PLCs over mcprotocol Ethernet protocol. 

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

### Prerequisites for Windows

* git	(Used for repository cloning/downloads)
* node.js	(Background system for Node-RED)
* Node-RED

### Install for Windows
Make a directory for the base files on the disk (somewhere secure) and open the created folder and open PowerShell (SHIFT + right_click) or "Git Bash Here" with right mouse inside the folder. Now enter the following:
```sh
cd c:/tempsourcefolder
git clone https://...../node-red-contrib-mcprotocol.git

cd ~/.node-red
npm install c:/tempsourcefolder/node-red-contrib-mcprotocol
```

### NOTES
1. For A series PLC, only 1E frames are supported
2. ASCII mode is currently not supported for frames 3E and 4E


#### Credits
* [plcpeople](https://github.com/plcpeople/mcprotocol) for his implementation of mcprotocol
* [Jozo132](https://github.com/Jozo132/node-omron-read.git) for his original implementation node-omron-read on which this contrib node was first based