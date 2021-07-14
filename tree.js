/*
 * This file is part of the Forge Window Manager extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

// Gnome imports
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

// Gnome Shell imports
const DND = imports.ui.dnd;

// Extension imports
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

// App imports
const Logger = Me.imports.logger;
const Utils = Me.imports.utils;
const WindowManager = Me.imports.windowManager;

var NODE_TYPES = Utils.createEnum([
    'ROOT',
    'MONITOR',
    'SPLIT',
    'WINDOW',
    'WORKSPACE',
]);

var LAYOUT_TYPES = Utils.createEnum([
    'STACK',
    'TABBED',
    'ROOT',
    'HSPLIT',
    'VSPLIT',
]);

/**
 * The container node to represent Forge
 */
var Node = GObject.registerClass(
    class Node extends GObject.Object {
        _init(type, data) {
            super._init();
            this._type = type;
            this._data = data;
            this._parent = null;
            this._nodes = [];
            this._floats = []; // handle the floating windows

            if (this._type === NODE_TYPES['WINDOW']) {
                this._actor = this._data.get_compositor_private();
            }
        }
    }
);

var Queue = GObject.registerClass(
    class Queue extends GObject.Object {
        _init() {
            super._init();
            this._elements = [];
        }

        enqueue(item) {
            this._elements.push(item);
        }

        dequeue() {
            return this._elements.shift();
        }
    }
);

var Tree = GObject.registerClass(
    class Tree extends GObject.Object {
        _init(forgeWm) {
            super._init();
            this._forgeWm = forgeWm;

            // Attach the root node
            let rootBin = new St.Bin();
            rootBin.show();
            this._root = new Node(NODE_TYPES['ROOT'], rootBin);
            this._root.layout = LAYOUT_TYPES['ROOT'];
            global.window_group.add_child(rootBin);

            this._initWorkspaces();
            this._initMonitors();
        }

        _initMonitors() {
            let monitors = global.display.get_n_monitors();
            let nodeWorkspaces = this.nodeWorkpaces;

            for (let i = 0; i < nodeWorkspaces.length; i++) {
                let nodeWs = nodeWorkspaces[i];
                for (let mi = 0; mi < monitors; mi++) {
                    let monitorWsNode = this.addNode(nodeWs._data, NODE_TYPES['MONITOR'], `mo${mi}ws${nodeWs._data.index()}`);
                    monitorWsNode.layout = LAYOUT_TYPES['HSPLIT'];
                }
            }

            Logger.debug(`initial monitors: ${monitors}`);
        }

        /**
         * Handles new and existing workspaces in the tree
         */
        _initWorkspaces() {
            let wsManager = global.display.get_workspace_manager();
            let workspaces = wsManager.get_n_workspaces();
            for(let i = 0; i < workspaces; i++) {
                let workspace = wsManager.get_workspace_by_index(i); 
                let existWsNode = this.findNode(workspace);
                if (existWsNode) continue;
                let newWsNode = this.addNode(this._root._data, NODE_TYPES['WORKSPACE'], workspace);
                newWsNode.layout = LAYOUT_TYPES['HSPLIT'];
            }
            Logger.debug(`initial workspaces: ${workspaces}`);
        }

        get nodeWorkpaces() {
            let _nodeWs = [];
            let criteriaMatchFn = (node) => {
                if (node._type === NODE_TYPES['WORKSPACE']) {
                    _nodeWs.push(node);
                }
            }

            this._walkFrom(this._root, criteriaMatchFn, this._traverseBreadthFirst);
            return _nodeWs;
        }

        addNode(toData, type, data) {
            let parentNode = this.findNode(toData);
            let child;

            if (parentNode) {
                child = new Node(type, data);
                parentNode._nodes.push(child);
                child._parent = parentNode;
            }
            return child;
        }

        findNode(data) {
            let searchNode;
            let criteriaMatchFn = (node) => {
                if (node._data === data) {
                    searchNode = node;
                }
            };

            this._walk(criteriaMatchFn, this._traverseBreadthFirst);

            return searchNode;
        }

        findNodeByActor(dataActor) {
            let searchNode;
            let criteriaMatchFn = (node) => {
                if (node._type === NODE_TYPES['WINDOW'] && 
                    node._actor === dataActor) {
                    searchNode = node;
                }
            };

            this._walk(criteriaMatchFn, this._traverseDepthFirst);

            return searchNode;
        }

        _findNodeIndex(items, node) {
            let index;

            for (let i = 0; i < items.length; i++) {
                let nodeItem = items[i];
                if (nodeItem._data === node._data) {
                    index = i;
                    break;
                }
            }

            return index;
        }

        // The depth of a node is the number of edges
        // from the root to the node.
        getDepthOf(node) {
            // TODO get the depth of a node
        }

        // The height of a node is the number of edges
        // from the node to the deepest leaf.
        getHeightOf(node) {
            // TODO get the height of a node
        }

        _getShownChildren(items) {
            let filterFn = (nodeWindow) => {
                if (nodeWindow._type === NODE_TYPES['WINDOW']) {
                    let floating = nodeWindow.mode === WindowManager.WINDOW_MODES['FLOAT'];
                    if (!nodeWindow._data.minimized && !floating) {
                        return true;
                    }
                }
                return false;
            };

            return items.filter(filterFn);
        }

        removeNode(fromData, node) {
            let parentNode = this.findNode(fromData);
            let nodeToRemove = null;
            let nodeIndex;

            if (parentNode) {
                nodeIndex = this._findNodeIndex(parentNode._nodes, node);

                if (nodeIndex === undefined) {
                    // do nothing
                } else {
                    // TODO re-adjust the children to the next sibling
                    nodeToRemove = parentNode._nodes.splice(nodeIndex, 1);
                }
            }

            return nodeToRemove;
        }

        render() {
            Logger.debug(`render tree`);
            let fwm = this._forgeWm;
            let criteriaFn = (node) => {
                if (node._type === NODE_TYPES['WINDOW']) {
                    Logger.debug(` window: ${node._data.get_wm_class()}`);

                    let parentNode = node._parent;
                    let windowRect;

                    // It is possible that the node might be detached from the tree
                    // TODO: if there is no parent, use the current window's workspace?
                    // Or the window can be considered as floating?
                    if (parentNode) {
                        let monitor = node._data.get_monitor();
                        // A nodeWindow's parent is a monitor
                        windowRect = node._data.get_work_area_for_monitor(monitor);

                        let shownChildren = this._getShownChildren(parentNode._nodes);
                        let numChild = shownChildren.length;
                        let floating = node.mode === WindowManager.WINDOW_MODES['FLOAT'];
                        Logger.debug(`  mode: ${node.mode.toLowerCase()}, grabop ${node._grabOp}`);
                        Logger.debug(`  workspace: ${node._data.get_workspace().index()}`);
                        Logger.debug(`  monitor: ${monitor}`);
                        Logger.debug(`  monitorWorkspace: ${parentNode._data}`);
                        if (numChild === 0 || floating) return;
                        
                        let childIndex = this._findNodeIndex(
                            shownChildren, node);
                        
                        let layout = parentNode.layout;
                        let splitHorizontally = layout === LAYOUT_TYPES['HSPLIT'];
                        let nodeWidth;
                        let nodeHeight;
                        let nodeX;
                        let nodeY;

                        if (splitHorizontally) {
                            // Divide the parent container's width 
                            // depending on number of children. And use this
                            // to setup each child window's width.
                            nodeWidth = Math.floor(windowRect.width / numChild);
                            nodeHeight = windowRect.height;
                            nodeX = windowRect.x + (childIndex * nodeWidth);
                            nodeY = windowRect.y;
                            Logger.debug(`  direction: h-split`);
                        } else { // split vertically
                            nodeWidth = windowRect.width;
                            // Conversely, divide the parent container's height 
                            // depending on number of children. And use this
                            // to setup each child window's height.
                            nodeHeight = Math.floor(windowRect.height / numChild);
                            nodeX = windowRect.x;
                            nodeY = windowRect.y + (childIndex * nodeHeight);
                            Logger.debug(` direction: v-split`);
                        }

                        let gap = 8;

                        nodeX += gap;
                        nodeY += gap;
                        nodeWidth -= gap * 2;
                        nodeHeight -= gap * 2;

                        Logger.debug(`  x: ${nodeX}, y: ${nodeY}, h: ${nodeHeight}, w: ${nodeWidth}`);

                        fwm.move(node._data, {x: nodeX, y: nodeY, width: nodeWidth, height: nodeHeight});
                    }

                } else if (node._type === NODE_TYPES['ROOT']) {
                    Logger.debug(` root`);
                } else if (node._type === NODE_TYPES['SPLIT']) {
                    Logger.debug(` split`);
                }
            };

            this._walk(criteriaFn, this._traverseBreadthFirst);
            Logger.debug(`render end`);
            Logger.debug(`--------------------------`);
        }

        // start walking from root and all child nodes
        _traverseBreadthFirst(callback, startNode) {
            let queue = new Queue();
            let beginNode = startNode ? startNode : this._root;
            queue.enqueue(beginNode);

            let currentNode = queue.dequeue();

            while(currentNode) {
                for (let i = 0, length = currentNode._nodes.length; i < length; i++) {
                    queue.enqueue(currentNode._nodes[i]);
                }

                callback(currentNode);
                currentNode = queue.dequeue();
            }
        }

        // start walking from bottom to root
        _traverseDepthFirst(callback, startNode) {
            let recurse = (currentNode) => {
                for (let i = 0, length = currentNode._nodes.length; i < length; i++) {
                    recurse(currentNode._nodes[i]);
                }

                callback(currentNode);
            };
            let beginNode = startNode ? startNode : this._root;
            recurse(beginNode);
        }

        _walk(callback, traversal) {
            traversal.call(this, callback);
        }

        _walkFrom(node, callback, traversal) {
            traversal.call(this, callback, node);
        }
    }
);
