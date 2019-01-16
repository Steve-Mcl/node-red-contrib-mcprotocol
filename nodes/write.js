module.exports = function (RED) {
  var connection_pool = require("../connection_pool.js");
  var util = require("util");

  function mcWrite(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name;
    this.topic = config.topic;
    this.connection = config.connection;
    this.address = config.address;
    this.data = config.data;
    this.address = config.address || "";//address
    this.addressType = config.addressType || "str";
    this.data = config.data || "";//data
    this.dataType = config.dataType || "num";

    this.connectionConfig = RED.nodes.getNode(this.connection);
    var context = this.context();
    var node = this;
    node.busy = false;
		node.busyTimeMax = 1000;//TODO: Parameterise hard coded value!
    //var mcprotocol = require('../mcprotocol.js');
    if (this.connectionConfig) {

      node.status({fill:"yellow",shape:"ring",text:"initialising"});
			var options = Object.assign({}, node.connectionConfig.options);
      this.client = connection_pool.get(this.connectionConfig.port, this.connectionConfig.host, options);

      this.client.on('error', function (error) {
        console.log("Error: ", error);
        node.status({fill:"red",shape:"ring",text:"error"});
      });
      this.client.on('open', function (error) {
        node.status({fill:"green",shape:"dot",text:"connected"});
      });
      this.client.on('close', function (error) {
        node.status({fill:"red",shape:"dot",text:"not connected"});
      });

      function myReply(problem, msg) {
        node.busy = false;//reset busy - allow node to be triggered
        clearTimeout(node.busyMonitor);

        if(msg.timeout)  {
          node.status({fill:"red",shape:"ring",text:"timeout"});
          node.error("timeout");
          var dbgmsg = {
            f: 'myReply(msg)',
            msg: msg,
            error: 'timeout'
          }
          console.error(dbgmsg);
          return;//halt flow
        }

				if(problem)  {
          node.status({fill:"grey",shape:"ring",text:"Quality Issue"});
				} else {
					node.status({fill:"green",shape:"dot",text:"Good"});
				}
        
        var newMsg = {payload: msg, name: node.name, topic : node.topic};

        node.send(newMsg);
      }
      this.on('input', function (msg) {
				if(msg.disconnect === true || msg.topic === 'disconnect'){
					this.client.closeConnection();
					return;
				} else if(msg.connect === true || msg.topic === 'connect'){
					this.client.connect();
					return;
        } 
         
        if (node.busy)
          return;//TODO: Consider queueing inputs?
        node.request = undefined;
        node.msgMem = msg;

        var isObject = function(val) {
          if (val === null) { return false;}
          return ( (typeof val === 'function') || (typeof val === 'object') );
        }
        var addr;// = /* node.address || */ config.address || msg.payload.address; 
        var data;
        //address - address
        RED.util.evaluateNodeProperty(node.address, node.addressType, node, msg, (err, value) => {
          if (err) {
            node.error("Unable to evaluate address");
            node.status({ fill: "red", shape: "ring", text: "Unable to evaluate address" });
            return;
          } else {
            addr = value;
            if (addr == "") {
              node.error("address is empty");
              node.status({ fill: "red", shape: "ring", text: "address is empty" });
              return;
            }
          }
        });


        //data - data
        var csv2arr = function (str) {
          return node.data.split(',').map(Number);
        }
        if (node.dataType == 'str') {
          data = node.data;
        } else if (node.dataType == 'num') {
          data = [node.data];
        } else if (node.dataType == 'csv') {
          data = csv2arr(node.data);
        } else {
          RED.util.evaluateNodeProperty(node.data, node.dataType, node, msg, (err, value) => {
            if (err) {
              node.error("Unable to evaluate data");
              node.status({ fill: "red", shape: "ring", text: "Unable to evaluate data" });
              return;
            } else {
              if (typeof value === "string") {
                data = csv2arr(value);
              } else {
                data = value;
              }
            }
          });
        }

        if(!data)	{
					node.error("Data is empty");
					return;
        }
        
        if (typeof data == "number") {
          data = [data];
        }
        // if (data.length != count) {
        //   node.error("data length and count are not equal");
        //   node.status({ fill: "red", shape: "ring", text: "data length and count are not equal" });
        //   return;
        // }
        
        try {
          node.status({fill:"yellow",shape:"ring",text:"write"});
          node.busy = true;
          if (node.busyTimeMax) {
            this.busyMonitor = setTimeout(function() {
              if(node.busy){
                node.status({fill:"red",shape:"ring",text:"timeout"});
                node.error("timeout");
                node.busy = false;
                return;
              }
            }, node.busyTimeMax);
          }          
          this.client.write(addr, data, myReply);
        } catch (error) {
          node.busy = false;
          node.error(error);
          node.status({fill:"red",shape:"ring",text:"error"});
          var dbgmsg = { 
						info: "write.js-->on 'input' - try this.client.write(addr, data, myReply)",
            connection: `host: ${node.connectionConfig.host}, port: ${node.connectionConfig.port}`, 
            address: addr,
            data: data,
						error: error
					 };
					console.debug(dbgmsg);
          return;
        }
        
      });
      node.status({fill:"green",shape:"ring",text:"ready"});

    } else {
      node.error("configuration not setup");
      node.status({fill:"red",shape:"ring",text:"error"});
    }

  }
  RED.nodes.registerType("MC Write", mcWrite);
  mcWrite.prototype.close = function() {
		if (this.client) {
			this.client.disconnect();
		}
	}
};

