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

var util = require("util");

var pool = {};

module.exports = {
  get: function(port, host, opts) {
    var mcprotocol = require("./mcprotocol/mcprotocol.js");
    var id = `mcprotocol: {host:'${host || ""}', port: ${port || "''"}}`;
    //var id = `mcprotocol: {host:'${(host || "")}', port: ${(port || "''")}, frame:'${frame}', plcType:'${plcType}}`;
    var node = this;

    if (!pool[id]) {
      pool[id] = (function() {
        var options = opts || {};
        options.host = host;
        options.port = port;
        options.protocol = options.protocol || "TCP";
        options.ascii = options.ascii || false;
        options.frame = options.frame || "3E";
        options.plcType = options.plcType || "Q";
        options.autoConnect =
          options.autoConnect == "undefined" ? true : options.autoConnect;
        options.preventAutoReconnect = false;
        options.logLevel = options.logLevel || "WARN";
        util.log(`[mcprotocol] adding new connection to pool ~ ${id}`);

        var mcp = new mcprotocol();

        mcp.setDebugLevel(options.logLevel);
        mcp.initiateConnection(options);
        var connecting = false;
        var obj = {
          getMCP: function mcp() {
            return mcp;
          },
          getAutoConnect: function() {
            return options.autoConnect == true;
          },
          setAutoConnect: function(b) {
            options.autoConnect = b == true;
          },
          _instances: 0,
          write: function(addr, data, callback) {
            if (!mcp.isConnected()) {
              //this.connect();
              throw new Error("Not connected!");
            }
            var reply = mcp.writeItems(addr, data, callback);
            return reply;
          },
          read: function(addr, callback) {
            if (!mcp.isConnected()) {
              //this.connect();
              throw new Error("Not connected!");
            }
            var reply = mcp.readItems(addr, callback);
            return reply;
          },
          closeConnection: function() {
            mcp.connectionReset();
            options.preventAutoReconnect = true;
          },
          on: function(a, b) {
            mcp.on(a, b);
          },
          connect: function() {
            options.preventAutoReconnect = false;
            if (mcp && !mcp.isConnected() && !connecting) {
              connecting = true;
              mcp.initiateConnection(options);
            }
          },

          disconnect: function() {
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

        mcp.on("error", function(e) {
          if (mcp) {
            util.log(`[mcprotocol] error ~ ${id}: ${e}`);
            connecting = false;
            if (options.autoConnect) {
              setTimeout(function() {
                if (options.autoConnect && !options.preventAutoReconnect) {
                  util.log(
                    `[mcprotocol] autoConnect call from  error handler ~ ${id}`
                  );
                  obj.connect();
                }
              }, 1000); //parametrise
            }
          }
        });
        mcp.on("open", function() {
          if (mcp) {
            util.log(`[mcprotocol] connected ~ ${id}`);
            connecting = false;
          }
        });
        mcp.on("close", function(err) {
          util.log(`[mcprotocol] connection closed ~ ${id}`);
          connecting = false;
          if (options.autoConnect) {
            setTimeout(function() {
              if (options.autoConnect && !options.preventAutoReconnect) {
                util.log(
                  `[mcprotocol] autoConnect call from close handler ~ ${id}`
                );
                obj.connect();
              }
            }, 1000); //parametrise
          }
        });

        return obj;
      })();
    }
    pool[id]._instances += 1;
    return pool[id];
  }
};
