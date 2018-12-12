node-red-contrib-mcprotocol
===========================

<img align="left" src=images/example.png />

### Overview
This is a Node-RED node module to directly interface with MITSUBISHI PLCs over mcprotocol Ethernet protocol. 
For now it only supports CS/CJ and CV mode for READ and WRITE operations over mcprotocol UDP.

Credits to [plcpeople](https://github.com/plcpeople/mcprotocol) for his implementation of mcprotocol
Credits to [Jozo132](https://github.com/Jozo132/node-omron-read.git) for his original implementation node-omron-read on which this is based

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

