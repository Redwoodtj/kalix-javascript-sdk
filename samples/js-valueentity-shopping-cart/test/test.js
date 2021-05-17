/*
 * Copyright 2021 Lightbend Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const path = require("path");
const should = require('chai').should();
const grpc = require("grpc");
const protoLoader = require("@grpc/proto-loader");
const fs = require("fs");
const protobuf = require("protobufjs");
const protobufHelper = require("@lightbend/akkaserverless-javascript-sdk/src/protobuf-helper");

const allIncludeDirs = protobufHelper.moduleIncludeDirs.concat([
  path.join(".")
]);

const packageDefinition = protoLoader.loadSync(
  [
    path.join("akkaserverless", "protocol", "discovery.proto"),
    path.join("akkaserverless", "component", "valueentity", "value_entity.proto")
  ],
  {
    includeDirs: allIncludeDirs
  });
const descriptor = grpc.loadPackageDefinition(packageDefinition);

const root = protobufHelper.loadSync([
  path.join("shoppingcart_api.proto"),
  path.join("shoppingcart_domain.proto")
], allIncludeDirs);

const Cart = root.lookupType("com.example.valueentity.shoppingcart.domain.Cart");

// Start server
const shoppingCartEntity = require("../shoppingcart.js");
const AkkaServerless = require("@lightbend/akkaserverless-javascript-sdk").AkkaServerless;
const server = new AkkaServerless();
server.addComponent(shoppingCartEntity);

let discoveryClient;
let valueEntityClient;

let commandId = 0;

function invokeDiscover() {
  return new Promise((resolve, reject) => {
    discoveryClient.discover({}, (err, descriptor) => {
      if (err) {
        reject(err);
      } else {
        descriptor.entities.should.have.lengthOf(1);
        resolve({
          proto: descriptor.proto,
          root: protobuf.Root.fromDescriptor({
            file: [descriptor.proto]
          }).resolveAll(),
          serviceName: descriptor.entities[0].serviceName
        });
      }
    });
  });
}

function callAndInit(snapshot) {
  const call = valueEntityClient.handle();
  call.write({
    init: {
      serviceName: "com.example.valueentity.shoppingcart.ShoppingCartService",
      entityKey: "123",
    }
  });
  return call;
}

function nextMessage(call) {
  let done;
  return new Promise((resolve, reject) => {
    call.on("data", msg => {
      done = true;
      resolve(msg);
    });
    call.on("end", () => {
      if (!done) {
        reject("Stream finished before next data was received");
      }
    });
  });
}

function fullNameOf(descriptor) {
  function namespace(desc) {
    if (desc.name === "") {
      return "";
    } else {
      return namespace(desc.parent) + desc.name + ".";
    }
  }
  return namespace(descriptor.parent) + descriptor.name;
}

function stripHostName(url) {
  const idx = url.indexOf("/");
  if (url.indexOf("/") >= 0) {
    return url.substr(idx + 1);
  } else {
    // fail?
    return url;
  }
}

function decodeAny(root, any) {
  let bytes = any.value;
  if (bytes === undefined) {
    // An empty buffer is falsey and so disappears, we need to make it reappear.
    bytes = new Buffer(0);
  }
  return root.lookupType(stripHostName(any.type_url)).decode(bytes);
}

function sendCommand(call, name, payload) {
  const cid = ++commandId;
  call.write({
    command: {
      id: cid,
      name: name,
      payload: {
        value: payload.constructor.encode(payload).finish(),
        url: "type.googleapis.com/" + fullNameOf(payload.constructor.$type)
      }
    }
  });
  return nextMessage(call).then(msg => {
    should.exist(msg.reply);
    msg.reply.commandId.toNumber().should.equal(cid);
    should.exist(msg.reply.clientAction.reply);
    msg.reply.decodedPayload = decodeAny(root, msg.reply.clientAction.reply.payload);
    if (msg.reply.events) {
      msg.reply.decodedEvents = msg.reply.events.map(event => {
        return decodeAny(root, event);
      });
    }
    return msg.reply;
  });
}

function sendEvent(call, sequence, event) {
  call.write({
    "event": {
      sequence: sequence,
      payload: {
        type_url: "type.googleapis.com/" + fullNameOf(event.constructor.$type),
        value: event.constructor.encode(event).finish()
      }
    }
  })
}

function getCart(call) {
  return sendCommand(call, "GetCart", root.lookupType("com.example.valueentity.shoppingcart.GetShoppingCart").create({
    cartId: "123"
  }));
}

function addItem(call, item) {
  return sendCommand(call, "AddItem", root.lookupType("com.example.valueentity.shoppingcart.AddLineItem").create(item));
}

describe("shopping cart", () => {

  before("start shopping cart server", () => {
    const port = server.start({
      bindPort: 0
    });
    discoveryClient = new descriptor.akkaserverless.protocol.Discovery("127.0.0.1:" + port, grpc.credentials.createInsecure());
    valueEntityClient = new descriptor.akkaserverless.component.valueentity.ValueEntities("127.0.0.1:" + port, grpc.credentials.createInsecure());
  });

  after("shutdown shopping cart server", () => {
    server.shutdown();
  });

  it("should respond to getCart commands", () => {
    const call = callAndInit();
    return getCart(call)
      .then(reply => {
        should.not.exist(reply.events);
        should.not.exist(reply.snapshot);
        reply.decodedPayload.items.should.be.empty;
        call.end();
      });
  });

  it("should respond to addItem commands", () => {
    const call = callAndInit();
    return addItem(call, {
      cartId: "123",
      productId: "abc",
      name: "Some product",
      quantity: 10
    }).then(reply => {
      return getCart(call);
    }).then(reply => {
      reply.decodedPayload.items[0].should.include({productId: "abc", name: "Some product", quantity: 10});
      call.end();
    });
  });

});
