/*
NEEDS REWRITE:
http://dl.mitsubishielectric.com/dl/fa/document/manual/plc/sh080008/sh080008x.pdf 
example on p341
*/
var util = require("util");
var mc = require('./mcprotocol');
var TESTS = [];
var TESTRESULTS = [];




	var conn = new mc;
	var doneReading = false;
	var doneWriting = false;

	var variables = { TEST1: 'D1234,55', 	// 55 words starting at D1234
		  TEST2: 'M6990,28', 			// 28 bits at M6990
		  TEST3: 'CN199,2',			// ILLEGAL as CN199 is 16-bit, CN200 is 32-bit, must request separately
		  TEST4: 'R2000,2',			// 2 words at R2000
		  TEST5: 'X034',				// Simple input
		  TEST6: 'D1000.1,16',			// 16 bits starting at D1000.1
		  TEST7: 'D6401.2',				// Single bit at D6001
		  TEST8: 'S4,2',				// 2 bits at S4
		  TEST9: 'RFLOAT5000,40',		// 40 floating point numbers at R5000	
		  TEST10: 'X020,32',		// 	
		  TEST11: 'M100,32',		// 	
		  TEST12: 'X0,9',		// 	
		  TEST13: 'X0,5',		// 	
		  TEST14: 'X0,17',		// 	
		  "D6401.1,16": 'D6401.1,16',		// 	
		  D100_2: 'D6401.1',		// 	
		  D100_2b: 'D6401.4',		// 	
		  D100_3: 'D6401',		// 	
		  D100_3b: 'D6402',		// 	
		  M1000: 'M2500,17',		// 	
		  Y: 'Y0,16',		// 	
      F3: 'F1000,12',		// 	
      TandDA_D0: "D0,100",
      TandSA1_D0: "D0,100:{n:2,s:2}",
      TandSA2_D0: "D0,100:{n:2,s:3}",
	};										// See setTranslationCB below for more examples

/* tests (Q06UDEH)...
  Common...
    Read/Write single item - OK
    Read/Write Array of items - OK
    Read/Write String - OK
  1E...
    D[int] Area - OK    can write −32768 to 32767
    DSTR Area - OK      can read/write strings of 1 to 1000 chars
    DUINT Area - OK can write 0 ~ 65535
    DINT Area - OK can write −32768 to 32767
    Area out of bounds (e.g. Y800) - OK (error code returned)
*/

function testResult(testID) {
  var self = this;
  self.testID = testID;
  self.status = "initialised";
  self.match =undefined;
  self.writeDone =false;
  self.readDone =false;
  self.match = undefined;
  self.writeErr = undefined;
  self.readErr = undefined;
  self.writeResult = undefined;
  self.readResult = undefined;
}

var makeStringOfSequentialLetters = function(strLength){
  var s = "0123456789";
  while (s.length < strLength) {
    s += s;
  }
  return s.substring(0,strLength);
};

function randomString(len) {
  let charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var randomString = '';
  for (var i = 0; i < len; i++) {
      var randomPoz = Math.floor(Math.random() * charSet.length);
      randomString += charSet.substring(randomPoz,randomPoz+1);
  }
  return randomString;
}

var makeWDArrayOfSequentialLettersAsHex = function(wordLength){
  let theChar = 46;//48 = "0"
  return Array(wordLength).fill().map(function(){
    theChar += 2;
    if(theChar > 56)
      theChar = 48;
    return (theChar ) + ((theChar + 1) << 8);
  } );
};   

const randomInt = function(min, max) {
  return Math.round(min + Math.random()*(max-min));
}
const randomBool = function() {
  return !!Math.round(Math.random()*1);
}
const randomArray = function(length, min, max) {
  if(min == max){
    return Array.apply(null, Array(length)).map(function() {
      return min;
    });
  } else if(min == 0 && (max == 1 || max == true)){
    return Array.apply(null, Array(length)).map(function() {
      return randomBool();
    }); 
  } else {
    return Array.apply(null, Array(length)).map(function() {
      return randomInt(min,max);
    }); 
  }  
}

const seqArray = function(start, end) {
  var inc = start < end ? 1 : -1; 
  var length = (Math.max(end, start) - Math.min(end, start)) + 1;
  if(!length)
    return [];

  var pos = start;
  return Array.apply(null, Array(length)).map(function() {
    var val = pos;
    pos = pos + inc;
    return val;
  }); 

}


const randomUINTArray = (length) => randomArray(length,0,65535);
const randomINTArray = (length) => randomArray(length,-32768,32767);
const randomBOOLArray = (length) => randomArray(length,0,1);
const singleValueValueArray = (length, value) => randomArray(length,value,value);
const zeroValueArray = (length) => singleValueValueArray(length,0);
var instanceNo = 0;
function testWriteRead(conn, addr,quantity,datagenerator, testID){
  var self = this;
  self.instanceNo = instanceNo;
  instanceNo++;
  console.log(`${timeStamp()} Preapring TEST# ${self.testID}: Write/Read '${addr},${quantity}'. (self.instanceNo==${self.instanceNo})`);

  self.testID = testID;
  self.result = new testResult(testID);
  self.result.addr = addr;
  self.result.quantity = quantity;
  self.addr = addr;
  self.quantity = quantity;
  self.datagenerator = datagenerator;
  self.plcConnection = conn;

  self.writeDone = function(err,result){
    self.result.status = `2 - Write Done (self.instanceNo==${self.instanceNo})`;
    self.result.writeDone = true;
    self.result.writeErr = err;
    self.result.writeResult = result;
  }
  self.readDone = function(err,result){
    //var self = this;
    self.result.status = `3 - Read Done (self.instanceNo==${self.instanceNo})`;
    self.result.readDone = true;
    self.result.readErr = err;
    self.result.readResult = result;
    if(result && result.value && Array.isArray(result.value)){
      self.result.match = (self.writeValue.length === result.value.length && self.writeValue.every((value, index) => value === result.value[index]));
    }
    if(result && (typeof(result.value) == "string" || typeof(result.value) == "numeric")){
      self.result.match = (self.writeValue === result.value);
    }
    if(self.result.match)
      self.result.status = `4 - Write/Read Done & compared OK (${self.testID}) (self.instanceNo==${self.instanceNo})`;
    else  
      self.result.status = `4 - Write/Read Done & compared NG! (${self.testID}) (self.instanceNo==${self.instanceNo})`;

    var r = JSON.stringify(result);
    console.log(`${timeStamp()} ${(err ? "🛑" : "👍")} TEST#${self.testID}: Write/Read '${addr},${quantity}' match==${(self.result.match?"🆗":"🆖")}. (self.instanceNo==${self.instanceNo})`);
  }
  self.runTest = function(){
    self.result.status = `1 - runTest() called (self.instanceNo==${self.instanceNo})`;
    self.writeValue = datagenerator(quantity);
    self.writeValue.testID = testID;
    self.readDone.testID = testID;
    self.writeDone.testID = testID;
  
    console.log(`${timeStamp()} calling writeItems(...).  TEST# ${self.testID}: Write/Read '${addr},${quantity}'.) (self.instanceNo==${self.instanceNo})`);
    self.plcConnection.writeItems(`${addr},${quantity}`,self.writeValue,self.writeDone);	
    console.log(`${timeStamp()} calling readItems(...).  TEST# ${self.testID}: Write/Read '${addr},${quantity}'.) (self.instanceNo==${self.instanceNo})`);
    self.plcConnection.readItems(`${addr},${quantity}`,self.readDone) ;

    return self.result;
  }
}

var timeStamp = function() {
  var time = new Date();
  return time.getHours() + ":" + time.getMinutes() + ":" + time.getSeconds() + '.' + time.getMilliseconds();
}
const convert = (baseFrom, baseTo) => number => parseInt(number, baseFrom).toString(baseTo);
const hex2dec = convert(16, 10);
const dec2hex = convert(10, 16);

//	conn.initiateConnection({port: 1031, host: '172.20.4.57', ascii: false}, connected); 
	//conn.initiateConnection({port: 1031, host: '172.20.4.113', frame: '3E', ascii: false}, connected); 
	//conn.initiateConnection({port: 1025, host: '172.20.4.55'/*rig*/, frame: '4E', ascii: false, plcType: "Q"}, connected); 
  //NGconn.initiateConnection({port: 5001, host: '172.20.4.119'/*32#1 RFID*/, PCStation: 2, frame: '4E', ascii: false, plcType: "Q"}, connected); 
   //conn.initiateConnection({port: 1028, host: '172.20.4.40'/*Tand DA*/,  frame: '4E', ascii: false, plcType: "Q"}, connected); 
  //conn.initiateConnection({port: 1027, host: '172.20.4.25'/*XL LOP*/,  frame: '3E', ascii: false, plcType: "Q"}, connected); 
  // conn.initiateConnection({
  //   port: 1031, host: '172.20.4.176', ascii: false, frame: '3E', plcType: 'Q/L',
  //   network: 1, PCStation: 5, PLCStation: 1
  //   }, connected); //27#2 plc2

  //DA  172.20.4.40 N1 S10
  //SA1 172.20.4.33 N1 S33


  conn.initiateConnection({
    port: 1027, host: '172.20.4.25', ascii: false, frame: '3E', plcType: 'Q/L',
    //port: 1027, host: '172.20.4.40', ascii: false, frame: '3E', plcType: 'Q/L',
    //network: 2, PCStation: 2//,  PLCStation: 0, PLCModuleNo: 2
    //network: 1, PCStation: 16//,  PLCStation: 0, PLCModuleNo: 2
    /*network: 1, /*PCStation: 3, PLCStation: 3, PLCModuleNo: 10*/
    }, connected); // 

  var donecount = 0;
  var callcount = 1;
   
  var cb = function(err,result){
    var r = JSON.stringify(result);
    var r2 = "";

    if(result && result.isGood){
      var msg = result;
      let data = msg.value;
      let iWD = msg.deviceNo;
      let loopBit = 0, bitNo = msg.bitOffset;
      let JSONData = {};
      if(msg.valueType == "CHAR") {
        switch(msg.deviceCodeNotation){
          case 'Decimal':
            buff_address = `${msg.deviceCode}${iWD}`
          break;
          case 'Hexadecimal':
            buff_address = `${msg.deviceCode}${Number(iWD).toString(16).toUpperCase()}`;
          break;
        }
        JSONData[buff_address] =  data;
      } else {

        for (var x in data) {
          let buff_address = '';

          if(msg.dataType == 'BIT' && msg.deviceCodeType != "BIT"){
            bitNo = msg.bitOffset + loopBit;
            if(bitNo == 16) iWD++;
            if(bitNo >= 16){
              bitNo = bitNo - 16
            }
            
            switch(msg.deviceCodeNotation){
              case 'Decimal':
                buff_address = `${msg.deviceCode}${iWD}.${Number(bitNo).toString(16).toUpperCase()}`
                JSONData[buff_address] =  data[x];
              break;
              case 'Hexadecimal':
                buff_address = `${msg.deviceCode}${Number(iWD).toString(16).toUpperCase()}.${Number(bitNo).toString(16).toUpperCase()}`
                JSONData[buff_address] =  data[x];
              break;
            }
            loopBit++;
            if(loopBit >= 16)
              loopBit = 0;
          } else {
            switch(msg.deviceCodeNotation){
              case 'Decimal':
                buff_address = `${msg.deviceCode}${iWD}`
                JSONData[buff_address] =  data[x];
              break;
              case 'Hexadecimal':
                buff_address = `${msg.deviceCode}${Number(iWD).toString(16).toUpperCase()}`
                JSONData[buff_address] =  data[x];
              break;
            }
            iWD += (msg.dataTypeByteLength/2);
          }
          
        }
      }
      console.log(`${timeStamp()} 📒 read callback. result - ${(err ? "🛑" : "👍")}. value...\n ${JSON.stringify(JSONData) }`); 
    }


    if(result && (result.valueType == "UINT" || result.valueType == "INT"  || result.valueType == "WORD" ) && result.value && Array.isArray(result.value)){
      result.value.forEach(function(el){
        if(r2) r2 += ",";
        r2 += dec2hex(el);
      })
      r2 = "[" + r2 + "]";
    }
    console.log(`${timeStamp()} 📒 read callback. result - ${(err ? "🛑" : "👍")}. value...\n ${r}\n${r2}`);
  };
  var wcb = function(err,result){
    var r = JSON.stringify(result);
    console.log(`${timeStamp()} ✏️ write callback. result - ${(err ? "🛑" : "👍")}. value...\n ${r}`);
  };

	function connected(err) {
		if (typeof(err) !== "undefined") {
			// We have an error.  Maybe the PLC is not reachable.  
			console.log(err);
			process.exit();
    }
    
    conn.on('error', function (e) {
        console.log(`[mcprotocol] error ~ ${id}: ${e}`);
    });
    conn.on('open', function () {
        util.log(`[mcprotocol] connected ~ ${id}`);
    });
    conn.on('close', function (err) {
      util.log(`[mcprotocol] connection closed ~ ${id}`);
    });



    // Setup TAG ~ Address "translation" (allow us to work with defined names in our app) 
    //NOTE: this is optional as we can use 'proper' addresses instead of TAG names
		conn.setTranslationCB(function(tag) {
      var addr = variables[tag];
      if(!addr)
        return tag;
      return addr;
    }); 	

   
    if(1){
      conn.setDebugLevel(3);
      //let ttt = new testWriteRead(conn, "D100",100,function(dummy){return seqArray(1000,1099);}, "1000-1099 INT in D1000");
      //ttt.runTest();
      //conn.writeItems("D0,100",seqArray(0,99),wcb) ;	//OK
      
      conn.readItems("D0,10",cb) ;	//
      conn.readItems("D0,10:{n:1,s:3}",cb) ;	//
      conn.readItems("D0,10:{n:1,s:1}",cb) ;	//
      conn.close
      // conn.readItems("TandDA_D0",cb) ;	//
      // conn.readItems("TandSA1_D0",cb) ;	//
      // conn.readItems("TandSA2_D0",cb) ;	//
      // conn.readItems("D0,10:{n:2,s:2}",cb) ;	//
      // conn.readItems("D0,10:{n:2,s:3}",cb) ;	//
      // conn.readItems("D0,10:{n:2,s:4}",cb) ;	//
      //conn.readItems("K8X5,20",cb) ;	//
      //conn.readItems("RDWORD2,20",cb) ;	//
      //conn.readItems("ZR700000,20",cb) ;	//

      // conn.readItems("SM400,101",cb) ;	//
      // conn.readItems("SD212,101",cb) ;	//
    }


    if(0){
      conn.setDebugLevel(3);
      let seqarr = seqArray(1000,1099);
      TESTS.push(new testWriteRead(conn, "D1000",100,function(dummy){return seqArray(1000,1099);}, "1000-1099 INT in D1000"));
      TESTS.push(new testWriteRead(conn, "D0",100,randomINTArray, "100 Random INT in D0"));
      TESTS.push(new testWriteRead(conn, "XUINT18",100,randomUINTArray, "100 Random UINT in X18"));
      TESTS.push(new testWriteRead(conn, "K4Y2B",10,randomINTArray, "100 Random INT in K4Y2B"));
      //TESTS.push(new testWriteRead(conn, "L0",100,randomBOOLArray, "100 Random BOOL in L0"));
      //TESTS.push(new testWriteRead(conn, "R0",100,randomString, "TEST3"));
      TESTS.push(new testWriteRead(conn, "X8",100,randomBOOLArray, "100 Random BOOL in X8"));
      TESTS.push(new testWriteRead(conn, "WSTR0",100,randomString, "100 ch Random STRING in W0"));
      TESTS.push(new testWriteRead(conn, "D2000",1000,function(len){return singleValueValueArray(len,0x5555)}, "1000 0x5555s --> d2000"));//OK!
      TESTS.push(new testWriteRead(conn, "D2000",1000,function(len){return seqArray(2000,2999)}, "2000 ~ 2999 into d2000"));//OK!
      TESTS.push(new testWriteRead(conn, "W0",100,randomINTArray, "100 Random INT in W0"));

      TESTS.forEach(function(test){
        //console.log(`calling runTest() on test# ${util.format(test)}...`);
        console.log(`calling runTest() on test# ${util.format(test.testID)}...`);
        test.runTest();
        //test.runTest();
        //test.runTest();
      })

      var timer = setInterval(() => {
        let allDone = TESTS.every(function(test){
          return test && test.result && test.result.writeDone && test.result.readDone;
        });
        if(allDone){
          console.log("All tests done. Results...");
          console.log(TESTS);
          clearInterval(timer);
        } 
      }, 500);
    }


    //example - adding items to POLL
    //conn.addItems(['D100_1','D100_2','D100_3','F3','Y','M1000']);	
    //conn.addItems(['D6401.1,16','D100_2','D100_2b','D100_3','D100_3b','DSTR6401,8','DBYTE6401,8']);	
    
 

    var read = function(addr,delay) {
      setTimeout(function(){
        var a = addr; // + ".1"
        console.log(`readItems(${a})`);
        let result = conn.readItems(a, cb);  
        let sresult = conn.enumSendResult[result];
        console.log(`readItems(${a}) returned '${sresult}'`)
        },delay);
    }

    var write = function(addr, val, delay) {
      setTimeout(function(){
        var a = addr; // + ".1"
        var v = val;
        console.log(`Writing ${v} to ${a}`);
        let result = conn.writeItems(a, v, valuesWritten);  
        let sresult = conn.enumSendResult[result];
        console.log(`writeItems(${a},${v}) returned '${sresult}'`)
      },delay);
    }
    
    
    
    
    /*
    
    let read1 = 'D6400'
    let read2 = 'D6401'//
    let read3 = 'D6402'
    let read4 = 'D6403'//
    let read5 = 'D6404'//
    let readitems = [read1,read2,read3,read4,read5,read1,read2,read3,read1,read2,read3,read1,read2,read3,read1,read2,read3];
    
    pos = 0;
    var timer = setInterval(() => {
      pos++
      let readwhat = readItems[pos];
      if(readwhat)
        conn.readItem(readItems[pos],cb) ;	
      else
        clearInterval(timer);
    }, 500);
    */
    
    /* Works 
    let tn = new Date();
    let v = [];
    v[0] = 6400 + tn.getSeconds();
    v[1] = v[0] + 1;
    let addr = 'D6400,2';
    console.log(`Writing value ${[...v]} to ${addr}`);
    conn.writeItems(addr,v, valuesWritten); 
    */
    

    /* tested with frame 3E + Q PLC
    conn.setDebugLevel(0);
    write("K4Y0,2",[0,0],0);
    read("K4Y1,2",200);
    write("Y0",1,400);
    write("Y2",1,610);
    write(["Y10","Y12"],[1,1],810);
    read("K4Y1,2",1010);
    */

    /*  tested OK
    write("K0Y0",0,0);
    write("Y0,6",[1,0,0,1,1,0],400);
    read("Y0,6",600);
    */
  

    
    if(0)
    { // tested ok 18-11-2018
      conn.setDebugLevel(0);
      let a = "K4Y0,2";
      let v = [123,321];
      conn.writeItems(a, v, function(err){
        conn.readItems(a, function(err,values) {
          console.log("Wrote:    " + util.format(v));
          console.log("Readback: " + util.format(values.value));
        })
      });   
    }
    
    if(0)
    { // tested ok 18-11-2018
      let a = "Y0,6";
      let v = [true,true,false,false,true,false];
      conn.writeItems(a, v, function(err){
        conn.readItems(a, function(err,values) {
          console.log("Wrote:    " + util.format(v));
          console.log("Readback: " + util.format(values.value));
        })
      });   
    }
    

    //write("Y2,4",[0,0,0,0],800);
    //read("Y0,6",1010);
  
    

    //////WORKS NICELY..........
    if(0) {
      let pos = 0;
      let mread0 = ['DSTR6400,4','D6400,4','DINT6400,4','DDINT6400','D6400.1,16','DFLOAT6400','Y0,5'];
      let mread0b = ['D6400.1,16','K4Y0,5','YUINT0,5'];//OK
      let mread0t = ['TS10,10','TN10,10'];//OK
      let mread0c = ['CS10,10','CN10,10'];//OK
      let mread0x = ['DF,10','DIT10,10','QUINTF0,10','DQINT6400,10'];//OK
      let mread1 = ['D6400','D6401','DSTR6422,4','DDINT6407'];
      let mread2 = ['D6410','DFLOAT6411','D6432','DREAL6417'];
      let mread3 = ['D6420','D6421','D6442','DDWORD6427'];
      let mread4 = ['D6430','DSTR6431,4','D6452','D6437'];
      let mread5 = ['D6450','D6451','D6462','D6457'];
      //let mreadItems = [mread0,mread2,mread3,mread4,mread5,mread1,mread2,mread3,mread1,mread2,mread3,mread1,mread2,mread3,mread1,mread2,mread3];
      let mreadItems = [mread0x];
      let timer2 = setInterval(() => {
        let readwhat = mreadItems[pos];
        pos++;
        if(readwhat)
          conn.readItems(readwhat,cb) ;	
        else
          clearInterval(timer2);
      }, 500);
    }      


      
    if(0){
      conn.setDebugLevel(1);
      conn.readItems(["1NG,4","K4Y0,4","2NGNGNG,4","K4Y4,4"],cb) ;	//NG OK NG OK
      conn.readItems("3NG,4",cb) ;	//NG
      conn.readItems(["4NG,4","K4Y0,4"],cb) ;	//NG OK
      conn.readItems(["K4Y0,4","5NG,4"],cb) ;	//OK NG
      conn.readItems("K4XF0,10",cb) ;	//OK
    }

      
    if(0){
      conn.setDebugLevel(2);
      //let ttt = new testWriteRead(conn, "D100",100,function(dummy){return seqArray(1000,1099);}, "1000-1099 INT in D1000");
      //ttt.runTest();
      //conn.writeItems("D0,100",seqArray(0,99),wcb) ;	//OK
      conn.readItems("D0,101",cb) ;	//OK
    }

    
    if(0) {
      conn.setDebugLevel(2);
      let i = 46;
      let data = Array(200).fill().map(function(){
        i += 2;
        if(i > 56)
          i = 48;
        return (i ) + ((i + 1) << 8);
      } );
      conn.writeItems("D6400,200",data ,wcb) ;	
      conn.writeItems("DSTR6400,2","1-" ,wcb) ;	
      conn.writeItems("DSTR6401,6","crazy." ,wcb) ;	

      //conn.readItems("D6400,500",cb) ;	
      conn.readItems(["D6400,50","D6450,50"],cb) ;	
      conn.readItems("DSTR6400,200",cb) ;	
     // conn.readItems("DSTR640000,7",cb) ;	

      // conn.writeItems(["DSTR6400,5","DSTR6410,5"],"greaaat",wcb) ;	
      // conn.readItems("DSTR6400,7",cb) ;	
      // conn.writeItems("DSTR6400,5","booga",wcb) ;	
      // conn.readItems("DSTR6400,7",cb) ;	
    }


    
    if(0){
      conn.setDebugLevel(2);
      let quantity = 100;
      let addr = "DUINT0"
      let writeValues = makeWDArrayOfSequentialLettersAsHex(quantity);
      

      conn.writeItems(`${addr},${quantity}`,writeValues,wcb) ;	
      conn.readItems(`${addr},${quantity}`,function(err,result){
        var r = JSON.stringify(result);
        let v1match = false;
        if(result && (result.valueType == "UINT" || result.valueType == "INT"  || result.valueType == "WORD" ) && result.value && Array.isArray(result.value)){
          v1match = (array1.length === array2.length && array1.every((value, index) => value === array2[index]))
        }
        console.log(`${timeStamp()} ${(err ? "🛑" : "👍")} TEST '${TEST}': Write/Read '${addr},${quantity}' match==${(v1match?"🆗":"🆖")}.`);
      }) ;	
      

    }

/*
    let readWhat = read1;
    console.log(`---------------------------------- calling readItem() ----------------------- (readWhat:${readWhat})`);
		conn.readItem(read1,cb) ;	
		conn.readItem(read2,cb) ;	
		conn.readItem(read3,cb) ;	
		conn.readItem(read4,cb) ;	
		conn.readItem(read5,cb) ;	
		conn.readItem(read6,cb) ;	
		conn.readItem(read7,cb) ;	
		conn.readItem(read8,cb) ;	
		conn.readItem(read9,cb) ;	

    readWhat = ['D6401.3,5','DSTR6401,8'];
    console.log(`---------------------------------- calling readItem() ----------------------- (readWhat:${readWhat})`);
    conn.readItem(['D6401.3,5','DSTR6401,8'], [
      function(err,result){
        if (err) { console.log("SOMETHING WENT WRONG WRITING VALUES!!!!"); }
        console.log('----------------------------------- readItem(D6401.3,5) callback------------------------- results...');
        console.log(result);
      },
      function(err,result){
        if (err) { console.log("SOMETHING WENT WRONG WRITING VALUES!!!!"); }
        console.log('----------------------------------- readItem(DSTR6401,8) callback------------------------- results...');
        console.log(result);
      }]);	


		//conn.addItems(['TEST12', 'TEST13']);	
    //conn.addItems('TEST14');
    
	//	conn.removeItems(['TEST2', 'TEST3']);  // We could do this.  
		//example conn.writeItems(['TEST5', 'TEST7'], [ true, true ], valuesWritten);  	// You can write an array of items as well.  
    //example conn.writeItems('TEST4', [ 666, 777 ], valuesWritten);  				// You can write a single array item too.  
    doneWriting = true;

    console.log(`---------------------------------- calling readAllItems() ----------------------- (callcount:${callcount})`);
    conn.readAllItems(valuesReady);	
    
    setTimeout(function(){
      callcount += 1;
      console.log(`---------------------------------- calling readAllItems() ----------------------- (callcount:${callcount})`);
      conn.readAllItems(valuesReady);	
    },1000);
    setTimeout(function(){
      callcount += 1;
      console.log(`---------------------------------- calling readAllItems() ----------------------- (callcount:${callcount})`);
      conn.readAllItems(valuesReady);	
    },2000);

    setInterval (function(){
        process.exit(); 
    },60000);
*/
	}

	function valuesReady(anythingBad, values) {
		if (anythingBad) { console.log("SOMETHING WENT WRONG READING VALUES!!!!"); }
    console.log('valuesReady() callback.   Values...');
    console.log(values);
    donecount += 1;
    if(donecount == 3)
      process.exit();
		//doneReading = true;
		//if (doneWriting) { process.exit(); }
	}

	function valuesWritten(anythingBad) {
		if (anythingBad) { console.log("SOMETHING WENT WRONG WRITING VALUES!!!!"); }
		console.log("Done writing.");
		doneWriting = true;
    if (doneReading) { 
      process.exit(); 
    }	
	}
