/**
 * Code Editor for the Cloud9 IDE
 *
 * @copyright 2010, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */

define(function(require, exports, module) {

var ide = require("core/ide");
var ext = require("core/ext");
var editors = require("ext/editors/editors");
var dock   = require("ext/dockpanel/dockpanel");
var commands = require("ext/commands/commands");


module.exports = {
    hook: function() {
        var _self = this;
        // register model
        var modelName = "mdlDbgBreakpoints"
        this.model = apf.nameserver.register("model", modelName, new apf.model());
        apf.setReference(modelName, this.model);
        mdlDbgBreakpoints.load("<breakpoints/>");
        
        ide.addEventListener("settings.load", function (e) {
            // restore the breakpoints from the IDE settings
            var bpFromIde = e.model.data.selectSingleNode("//breakpoints");
            // not there yet, create element
            if (!bpFromIde) {
                bpFromIde = e.model.data.ownerDocument.createElement("breakpoints");
                e.model.data.appendChild(bpFromIde);
            }
            // bind it to the Breakpoint model
            mdlDbgBreakpoints.load(bpFromIde);
        });

        // register dock panel
        var name =  "ext/debugger/debugger";
        dock.register(name, "dbgBreakpoints", {
            menu : "Debugger/Breakpoints",
            primary : {
                backgroundImage: ide.staticPrefix + "/ext/main/style/images/debugicons.png",
                defaultState: { x: -8, y: -88 },
                activeState: { x: -8, y: -88 }
            }
        }, function(type) {
            // ext.initExtension(_self);
            return dbgBreakpoints;
        });
        
        // ide.addEventListener("afteropenfile", evHandler);
        ide.addEventListener("afterfilesave", function(e) {
            var page = e.nextPage;
            if (!page || !page.$editor || !page.$editor.ceEditor)
                return;
            var ace = page.$editor.ceEditor.$editor
            if (!ace.$breakpointListener)
                _self.initEditor(ace);
            
            if (!ace.session.$breakpointListener)
                _self.initSession(ace.session);

            _self.updateSession(ace.session, page.$doc.getNode());
        });
        ide.addEventListener("tab.afterswitch", function(e) {
            var page = e.nextPage;
            if (!page || !page.$editor || !page.$editor.ceEditor)
                return;
            var ace = page.$editor.ceEditor.$editor
            if (!ace.$breakpointListener)
                _self.initEditor(ace);
            
            if (!ace.session.$breakpointListener)
                _self.initSession(ace.session);

            _self.updateSession(ace.session, page.$doc.getNode());
        });
    },
    
    initEditor: function(editor) {
        var _self = this;
        var el = document.createElement("div");
        editor.renderer.$gutter.appendChild(el);
        el.style.cssText = "position:absolute;top:0;bottom:0;left:0;width:18px;cursor:pointer"
        
        editor.on("guttermousedown", editor.$breakpointListener = function(e) {
            if (!editor.isFocused())
                return;
            var gutterRegion = editor.renderer.$gutterLayer.getRegion(e);
            if (gutterRegion != "markers")
                return;
            var row = e.getDocumentPosition().row;

            var session = editor.session;
            var bp = session.getBreakpoints()[row];
            if (!bp)
                bp = " ace_breakpoint ";
            else if(bp.indexOf("disabled") == -1)
                bp = " ace_breakpoint disabled ";
            else
                bp = null;

            session.setBreakpoint(row, bp);
            
            session.getBreakpoints();
            session.c9doc.getNode();
        });
    },
    initSession: function(session) {
        session.$breakpointListener = function(e) {
        	var delta = e.data;
			var range = delta.range;
			var len, firstRow, f1;
            
            if (range.end.row == range.start.row)
                return;
			
            len = range.end.row - range.start.row;
			if (delta.action == "insertText") {
				firstRow = range.start.column == 0 ? range.start.row: range.start.row + 1;
			} else {
				firstRow = range.start.row;
			}

			if (len > 0) {
				args = Array(len);
				args.unshift(firstRow, 0)
				this.$breakpoints.splice.apply(this.$breakpoints, args);
            } else if (len < 0) {
                var rem = this.$breakpoints.splice(firstRow + 1, -len);
				
                if(!this.$breakpoints[firstRow]){
					for each(var oldBP in rem)
						if (oldBP){
							this.$breakpoints[firstRow] = oldBP
							break
						}
				}
			}
        }.bind(session);
        session.on("change", session.$breakpointListener);
    },
    updateSession: function(session, node) {
        var rows = [];
        if (node) {
            var path = node.getAttribute("path");
            var scriptPath = path.slice(ide.davPrefix.length);
            var breakpoints = mdlDbgBreakpoints.queryNodes("//breakpoint[@scriptPath='" + scriptPath + "']");

            for (var i=0; i< breakpoints.length; i++) {
                var bp = breakpoints[i]
                var line = parseInt(bp.getAttribute("line"), 10);
                var offset = parseInt(bp.getAttribute("lineoffset"), 10);
                var enabled = apf.isTrue(bp.getAttribute("enabled"));
                rows[line] = " ace_breakpoint " + enabled ? "" : "disabled ";
            }
        }
        session.setBreakpoints(rows);
    },
    
    init: function() {
        var _self = this;
        dbgBreakpoints.addEventListener("afterrender", function() {
            lstBreakpoints.addEventListener("afterselect", function(e) {
                if (e.selected) {
                    _self.gotoBreakpoint(e.selected)
                }
            });
            
            lstBreakpoints.addEventListener("aftercheck", function(e) {
                _self.setBreakPointEnabled(e.xmlNode, 
                    apf.isTrue(e.xmlNode.getAttribute("enabled")));
            });
        });

        dbgBreakpoints.addEventListener("dbInteractive", function(){
            lstScripts.addEventListener("afterselect", function(e) {
                e.selected && _self.gotoBreakpoint(e.selected);
            });
        });
    },
    
    gotoBreakpoint: function(bp) {
        var line = parseInt(bp.getAttribute("line"), 10);
        var column = parseInt(bp.getAttribute("column"), 10);
        if (isNaN(line)) line = null;
        if (isNaN(column)) column = null;
        var scriptPath = bp.getAttribute("scriptPath");
        
        
        
    },
    
    toggleBreakpoint : function(script, row, content) {
        var scriptName = script.getAttribute("scriptname");
        var bp = model.queryNode("breakpoint[@script='" + scriptName
            + "' and @line='" + row + "']");

        if (bp) {
            apf.xmldb.removeNode(bp);
        }
        else {
            // filename is something like blah/blah/workspace/realdir/file
            // we are only interested in the part after workspace for display purposes
            var tofind = "/workspace/";
            var path = script.getAttribute("path");
            var displayText = path;
            if (path.indexOf(tofind) > -1) {
                displayText = path.substring(path.indexOf(tofind) + tofind.length);
            }

            var bp = apf.n("<breakpoint/>")
                .attr("script", scriptName)
                .attr("line", row)
                .attr("text", displayText + ":" + (parseInt(row, 10) + 1))
                .attr("lineoffset", 0)
                .attr("content", content)
                .attr("enabled", "true")
                .node();
            model.appendXml(bp);
        }
    },

    setBreakPointEnabled : function(node, value){
        node.setAttribute("enabled", value ? true : false);
    },
    
    $syncTree: function() {
        if (this.inSync) return;
        this.inSync = true;
        var dbgFiles = mdlDbgSources.data.childNodes;

        var workspaceDir = ide.workspaceDir;
        for (var i=0,l=dbgFiles.length; i<l; i++) {
            var dbgFile = dbgFiles[i];
            var name = dbgFile.getAttribute("scriptname");
            if (name.indexOf(workspaceDir) !== 0)
                continue;
            this.paths[name] = dbgFile;
        }
        var treeFiles = fs.model.data.getElementsByTagName("file");
        var tabFiles = ide.getAllPageModels();
        var files = tabFiles.concat(Array.prototype.slice.call(treeFiles, 0));

        var davPrefix = ide.davPrefix;
        for (var i=0,l=files.length; i<l; i++) {
            var file = files[i];
            var path = file.getAttribute("scriptname");

            var dbgFile = this.paths[path];
            if (dbgFile)
                apf.b(file).attr("scriptid", dbgFile.getAttribute("scriptid"));
        }
        this.inSync = false;
    },
}

});
