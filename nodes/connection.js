
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
    this.options.PLCStation = config.PLCStation ? config.PLCStation : 0;
    this.options.PCStation = config.PCStation ? config.PCStation : 0xff;
    this.options.PLCModuleNo = config.PLCModuleNo ? config.PLCModuleNo : 0x3ff;
    this.options.network = config.network ? config.network : 0;
    this.options.octalInputOutput = config.octalInputOutput
      ? config.octalInputOutput
      : false;
  }
  RED.nodes.registerType("MC Protocol Connection", mcConnection);
};
