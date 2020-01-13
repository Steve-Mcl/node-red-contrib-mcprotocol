var util = require("util");


var pool = {};


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
    
    if (!pool[id]) {
      pool[id] = function () {
        var options = opts || {};
        options.host = host;
        options.port = port;
        options.protocol = options.protocol || "TCP";
        options.ascii = options.ascii || false;
        options.frame = options.frame || "3E";
        options.plcType = options.plcType || "Q";
        options.autoConnect = options.autoConnect == "undefined" ? true : options.autoConnect;
        options.preventAutoReconnect = false;
        
        util.log(`[mcprotocol] adding new connection to pool ~ ${id}`);

        var mcp = new mcprotocol();
        
        mcp.setDebugLevel("WARN");
        mcp.initiateConnection(options);
        var connecting = false;
        var obj = {
          getMCP: function mcp() {
            return mcp;
          },
          getAutoConnect: function() {
            return (options.autoConnect == true);
          },
          setAutoConnect: function(b) {
            options.autoConnect = (b == true);
          },
          _instances: 0,
          write: function (addr, data, callback) {
            if(!mcp.isConnected()){
              //this.connect();
              throw new Error("Not connected!")
            }
            var reply = mcp.writeItems(addr, data, callback);
            return reply;
          },
          read: function (addr, callback) {
            if(!mcp.isConnected()){
              //this.connect();
              throw new Error("Not connected!")
            }
            var reply = mcp.readItems(addr, callback);
            return reply;
          },
          closeConnection: function(){
            mcp.connectionReset();
            options.preventAutoReconnect = true;
          },
          on: function (a, b) {
            mcp.on(a, b);
          },
          connect: function () {
            options.preventAutoReconnect = false;
            if (mcp && !mcp.isConnected() && !connecting) {
              connecting = true;
              mcp.initiateConnection(options);
            }
          },
          
          // decodeMemoryAddress : function (addressString)  {
          //   return mcp.decodeMemoryAddress(addressString);
          // },

          // decodedAddressToString : function (decodedAddress, offsetWD, offsetBit)  {
          //   return mcp.decodedAddressToString(decodedAddress, offsetWD, offsetBit);
          // },

          disconnect: function () {
            this._instances -= 1;
            if (this._instances <= 0) {
              util.log(`[mcprotocol] closing connection ~ ${id}`);
              mcp.dropConnection();
              mcp = null;
              util.log(`[mcprotocol] deleting connection from pool ~ ${id}`);
              delete pool[id];
            }
          }
        };
        
        mcp.on('error', function (e) {
          if (mcp) {
            util.log(`[mcprotocol] error ~ ${id}: ${e}`);
            connecting = false;
            if(options.autoConnect){
              setTimeout(function () {
                if(options.autoConnect && !options.preventAutoReconnect){
                  util.log(`[mcprotocol] autoConnect call from  error handler ~ ${id}`);
                  obj.connect();
                }
              },  1000); //parameterise
            }
          }
        });
        mcp.on('open', function () {
          if (mcp) {
            util.log(`[mcprotocol] connected ~ ${id}`);
            connecting = false;
          }
        });
        mcp.on('close', function (err) {
          util.log(`[mcprotocol] connection closed ~ ${id}`);
          connecting = false;
          if(options.autoConnect){
            setTimeout(function () {
              if(options.autoConnect && !options.preventAutoReconnect){
                util.log(`[mcprotocol] autoConnect call from close handler ~ ${id}`);
                obj.connect();
              }
            },  1000); //parameterise
          }
        });

        return obj
      }();
    }
    pool[id]._instances += 1;
    return pool[id];
  }
};