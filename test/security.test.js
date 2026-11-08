'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedSender, protectWindow } = require('../lib/security');
const { EventEmitter } = require('node:events');

const entry = 'file:///C:/Users/RUNNER%7E1/AppData/Local/Programs/YT/app.asar/index.html';
const actual = entry.replace('%7E', '~');
function allowed(url, expected = entry) {
    const frame = {url}, contents = {mainFrame:frame};
    return trustedSender({sender:contents,senderFrame:frame},contents,expected);
}
test('Node and Chromium tilde URL encodings identify the same local entry', () => {
    assert.equal(allowed(actual),true);
    assert.equal(allowed(entry.replace('%7E','%7e')),true);
    assert.equal(allowed(entry,actual),true);
});
test('encoded entry matching never accepts another path, scheme, fragment or query', () => {
    for (const value of [actual+'?x=1',actual+'#frame',actual+'/child',actual.replace('index.html','other.html'),
        actual.replace('file:','https:'),actual.replace('file:///','file://remote/'),
        entry.replace('%7E','%257E'),actual.replace('/YT/','%2FYT%2F'),'',undefined]) {
        assert.equal(allowed(value),false,String(value));
    }
});
test('URL equivalence never bypasses main-frame and webContents identity', () => {
    const frame = {url:actual}, contents = {mainFrame:frame};
    assert.equal(trustedSender({sender:{},senderFrame:frame},contents,entry),false);
    assert.equal(trustedSender({sender:contents,senderFrame:{url:actual}},contents,entry),false);
});
test('navigation keeps the same strict entry-only boundary with equivalent encoding', () => {
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = handler => { contents.popupHandler=handler; };
    contents.session = {setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
    protectWindow({webContents:contents},entry);
    let blocked=0;
    const event={preventDefault(){blocked++;}};
    contents.emit('will-navigate',event,actual);assert.equal(blocked,0);
    contents.emit('will-navigate',event,actual+'?other=1');assert.equal(blocked,1);
    contents.emit('will-redirect',event,actual);assert.equal(blocked,2);
    assert.deepEqual(contents.popupHandler(),{action:'deny'});
});
