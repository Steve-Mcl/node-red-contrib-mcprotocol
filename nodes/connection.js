/*
MIT License

Copyright (c) 2019, 2020 Steve-Mcl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. 
*/

function isNumeric(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}

function safeInt(int, def) {
  try {
    if(typeof int == "number") return parseInt(int);
    if(isNumeric(int)) return parseInt(int);
  } catch (e) { }
  return def
}

module.exports = function(RED) {
  function mcConnection(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.host = config.host;
    this.port = config.port;
    this.options = {};
    this.options.protocol = config.protocol ? config.protocol : "TCP";
    this.options.plcType = config.plcType ? config.plcType : "Q";
    this.options.frame = config.frame ? config.frame : "3E";
    this.options.ascii = config.ascii ? config.ascii : false;
    this.options.PLCStation = safeInt(config.PLCStation, 0);
    this.options.PCStation = safeInt(config.PCStation, 0xff);
    this.options.PLCModuleNo = safeInt(config.PLCModuleNo, 0x3ff);
    this.options.network = safeInt(config.network, 0);
    this.options.timeout = safeInt(config.timeout, 1000);
    this.options.octalInputOutput = config.octalInputOutput
      ? config.octalInputOutput
      : false;
  }
  RED.nodes.registerType("MC Protocol Connection", mcConnection);
};
