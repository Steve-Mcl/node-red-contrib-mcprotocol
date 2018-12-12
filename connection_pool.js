var util = require("util");

var clients = {};


// function convertPayloadToDataArray(payload) {
//   var array = [];
//   var str = '';
  
//   if (Array.isArray(payload)) {
//     return payload;
//   } else if (typeof payload === "string") {
//     str = "" + payload;
//   } else if (typeof payload === "object") {
//     str = "" + payload.data;
//   } else {
//     array = payload;
//   }

//   if (str.length === 0) {
//     return null;
//   } else {
//     array = str.split(/\s*,\s*/).map(Number);
//   }
//   return array;
// }


module.exports = {
  
  get: function (port,host,opts) {
    var mcprotocol = require('./mcprotocol/mcprotocol.js');
    var id = `mcprotocol: {host:'${(host || "")}', port: ${(port || "''")}}`;
    //var id = `mcprotocol: {host:'${(host || "")}', port: ${(port || "''")}, frame:'${frame}', plcType:'${plcType}}`;
    var node = this;
    
    if (!clients[id]) {
      clients[id] = function () {
        var options = opts || {};
        options.host = host;
        options.port = port;
        options.ascii = options.ascii || false;
        options.frame = options.frame || "3E";
        options.plcType = options.plcType || "Q";

        util.log(`[mcprotocol] adding new connection to pool ~ ${id}`);

        var client = new mcprotocol();
        client.setDebugLevel("WARN");//
        client.initiateConnection(options);
        var connecting = false;
        var obj = {

          _instances: 0,
          write: function (addr, data, callback) {
            if(!client.isConnected()){
              this.connect();
              throw new Error("Not connected!")
            }
            var reply = client.writeItems(addr, data, callback);
            return reply;
          },
          read: function (addr, callback) {
            if(!client.isConnected()){
              this.connect();
              throw new Error("Not connected!")
            }
            var reply = client.readItems(addr, callback);
            return reply;
          },
          on: function (a, b) {
            client.on(a, b);
          },
          connect: function () {
            if (client && !client.isConnected() && !connecting) {
              connecting = true;
              client.initiateConnection(options);
            }
          },
          
          // decodeMemoryAddress : function (addressString)  {
          //   return client.decodeMemoryAddress(addressString);
          // },

          // decodedAddressToString : function (decodedAddress, offsetWD, offsetBit)  {
          //   return client.decodedAddressToString(decodedAddress, offsetWD, offsetBit);
          // },

          disconnect: function () {
            this._instances -= 1;
            if (this._instances <= 0) {
              util.log(`[mcprotocol] closing connection ~ ${id}`);
              client.dropConnection();
              client = null;
              util.log(`[mcprotocol] deleting connection from pool ~ ${id}`);
              delete clients[id];
            }
          }
        };
        
        client.on('error', function (e) {
          if (client) {
            util.log(`[mcprotocol] error ~ ${id}: ${e}`);
            connecting = false;
            setTimeout(function () {
              obj.connect();
            },  1000); //parameterise
          }
        });
        client.on('open', function () {
          if (client) {
            util.log(`[mcprotocol] connected ~ ${id}`);
            connecting = false;
            
          }
        });
        client.on('close', function (err) {
          util.log(`[mcprotocol] connection closed ~ ${id}`);
          connecting = false;
          setTimeout(function () {
            obj.connect();
          },  1000); //parameterise
        });

        return obj
      }();
    }
    clients[id]._instances += 1;
    return clients[id];
  }
};