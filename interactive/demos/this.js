function getX() {
    return this.x;
}
var obj = { x: 42 };
getX.call(obj);
