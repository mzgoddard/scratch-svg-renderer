const inlineSvgFonts = require('./font-inliner');
const SvgElement = require('./svg-element');
const convertFonts = require('./font-converter');
const fixupSvgString = require('./fixup-svg-string');
const transformStrokeWidths = require('./transform-applier');

const paper = require('@scratch/paper');

let _project = null;
let _renderProject = null;

/**
 * Main quirks-mode SVG rendering code.
 */
class SvgRenderer {
    /**
     * Create a quirks-mode SVG renderer for a particular canvas.
     * @param {HTMLCanvasElement} [canvas] An optional canvas element to draw to. If this is not provided, the renderer
     * will create a new canvas.
     * @constructor
     */
    constructor (canvas) {
        this._canvas = canvas || document.createElement('canvas');
        this._context = this._canvas.getContext('2d');
        this._measurements = {x: 0, y: 0, width: 0, height: 0};
        this._cachedImage = null;
    }

    /**
     * @returns {!HTMLCanvasElement} this renderer's target canvas.
     */
    get canvas () {
        return this._canvas;
    }

    /**
     * Load an SVG from a string and draw it.
     * This will be parsed and transformed, and finally drawn.
     * When drawing is finished, the `onFinish` callback is called.
     * @param {string} svgString String of SVG data to draw in quirks-mode.
     * @param {number} [scale] - Optionally, also scale the image by this factor (multiplied by `getDrawRatio()`).
     * @param {Function} [onFinish] Optional callback for when drawing finished.
     */
    fromString (svgString, scale, onFinish) {
        if (typeof svgString === 'object') {
            return this.fromPaper(svgString, scale, onFinish);
        }

        this.loadString(svgString);
        this._draw(scale, onFinish);
    }

    fromPaper (paperJson, scale, onFinish) {
        this.loadPaper(paperJson);
        this._draw(scale, onFinish);
    }

    /**
     * Load an SVG from a string and measure it.
     * @param {string} svgString String of SVG data to draw in quirks-mode.
     * @return {object} the natural size, in Scratch units, of this SVG.
     */
    measure (svgString) {
        this.loadString(svgString);
        return this._measurements;
    }

    /**
     * @return {Array<number>} the natural size, in Scratch units, of this SVG.
     */
    get size () {
        return [this._measurements.width, this._measurements.height];
    }

    /**
     * @return {Array<number>} the offset (upper left corner) of the SVG's view box.
     */
    get viewOffset () {
        return [this._measurements.x, this._measurements.y];
    }

    /**
     * Load an SVG string and normalize it. All the steps before drawing/measuring.
     * @param {!string} svgString String of SVG data to draw in quirks-mode.
     * @param {?boolean} fromVersion2 True if we should perform conversion from
     *     version 2 to version 3 svg.
     */
    loadString (svgString, fromVersion2) {
        // New svg string invalidates the cached image
        this._cachedImage = null;
        this._cachedJson = null;

        this._svgString = svgString;

        // Parse string into SVG XML.
        const parser = new DOMParser();
        svgString = fixupSvgString(svgString);
        this._svgDom = parser.parseFromString(svgString, 'text/xml');
        if (this._svgDom.childNodes.length < 1 ||
            this._svgDom.documentElement.localName !== 'svg') {
            throw new Error('Document does not appear to be SVG.');
        }
        this._svgTag = this._svgDom.documentElement;
        if (fromVersion2) {
            // Fix gradients. Scratch 2 exports no x2 when x2 = 0, but
            // SVG default is that x2 is 1. This must be done before
            // transformStrokeWidths since transformStrokeWidths affects
            // gradients.
            this._transformGradients();
        }
        transformStrokeWidths(this._svgTag, window);
        this._transformImages(this._svgTag);
        if (fromVersion2) {
            // Transform all text elements.
            this._transformText();
            // Transform measurements.
            this._transformMeasurements();
        } else if (!this._svgTag.getAttribute('viewBox')) {
            // Renderer expects a view box.
            this._transformMeasurements();
        } else if (!this._svgTag.getAttribute('width') || !this._svgTag.getAttribute('height')) {
            this._svgTag.setAttribute('width', this._svgTag.viewBox.baseVal.width);
            this._svgTag.setAttribute('height', this._svgTag.viewBox.baseVal.height);
        }
        this._measurements = {
            width: this._svgTag.viewBox.baseVal.width,
            height: this._svgTag.viewBox.baseVal.height,
            x: this._svgTag.viewBox.baseVal.x,
            y: this._svgTag.viewBox.baseVal.y
        };

        // console.log(this._measurements);
        // console.log(this._svgString === this.toString(false));
        // console.log(this._svgString === this.toString(true));
    }

    loadPaper (json) {
        // console.log('loadPaper', json);
        this._cachedImage = null;
        this._cachedJson = json.paper;
        this._measurements = json.measurements;
    }

    /**
     * Transforms an SVG's text elements for Scratch 2.0 quirks.
     * These quirks include:
     * 1. `x` and `y` properties are removed/ignored.
     * 2. Alignment is set to `text-before-edge`.
     * 3. Line-breaks are converted to explicit <tspan> elements.
     * 4. Any required fonts are injected.
     */
    _transformText () {
        // Collect all text elements into a list.
        const textElements = [];
        const collectText = domElement => {
            if (domElement.localName === 'text') {
                textElements.push(domElement);
            }
            for (let i = 0; i < domElement.childNodes.length; i++) {
                collectText(domElement.childNodes[i]);
            }
        };
        collectText(this._svgTag);
        convertFonts(this._svgTag);
        // For each text element, apply quirks.
        for (const textElement of textElements) {
            // Remove x and y attributes - they are not used in Scratch.
            textElement.removeAttribute('x');
            textElement.removeAttribute('y');
            // Set text-before-edge alignment:
            // Scratch renders all text like this.
            textElement.setAttribute('alignment-baseline', 'text-before-edge');
            textElement.setAttribute('xml:space', 'preserve');
            // If there's no font size provided, provide one.
            if (!textElement.getAttribute('font-size')) {
                textElement.setAttribute('font-size', '18');
            }
            let text = textElement.textContent;

            // Fix line breaks in text, which are not natively supported by SVG.
            // Only fix if text does not have child tspans.
            // @todo this will not work for font sizes with units such as em, percent
            // However, text made in scratch 2 should only ever export size 22 font.
            const fontSize = parseFloat(textElement.getAttribute('font-size'));
            const tx = 2;
            let ty = 0;
            let spacing = 1.2;
            // Try to match the position and spacing of Scratch 2.0's fonts.
            // Different fonts seem to use different line spacing.
            // Scratch 2 always uses alignment-baseline=text-before-edge
            // However, most SVG readers don't support this attribute
            // or don't support it alongside use of tspan, so the translations
            // here are to make up for that.
            if (textElement.getAttribute('font-family') === 'Handwriting') {
                spacing = 2;
                ty = -11 * fontSize / 22;
            } else if (textElement.getAttribute('font-family') === 'Scratch') {
                spacing = 0.89;
                ty = -3 * fontSize / 22;
            } else if (textElement.getAttribute('font-family') === 'Curly') {
                spacing = 1.38;
                ty = -6 * fontSize / 22;
            } else if (textElement.getAttribute('font-family') === 'Marker') {
                spacing = 1.45;
                ty = -6 * fontSize / 22;
            } else if (textElement.getAttribute('font-family') === 'Sans Serif') {
                spacing = 1.13;
                ty = -3 * fontSize / 22;
            } else if (textElement.getAttribute('font-family') === 'Serif') {
                spacing = 1.25;
                ty = -4 * fontSize / 22;
            }

            if (textElement.transform.baseVal.length === 0) {
                const transform = this._svgTag.createSVGTransform();
                textElement.transform.baseVal.appendItem(transform);
            }

            // Right multiply matrix by a translation of (tx, ty)
            const mtx = textElement.transform.baseVal.getItem(0).matrix;
            mtx.e += (mtx.a * tx) + (mtx.c * ty);
            mtx.f += (mtx.b * tx) + (mtx.d * ty);

            if (text && textElement.childElementCount === 0) {
                textElement.textContent = '';
                const lines = text.split('\n');
                text = '';
                for (const line of lines) {
                    const tspanNode = SvgElement.create('tspan');
                    tspanNode.setAttribute('x', '0');
                    tspanNode.setAttribute('style', 'white-space: pre');
                    tspanNode.setAttribute('dy', `${spacing}em`);
                    tspanNode.textContent = line ? line : ' ';
                    textElement.appendChild(tspanNode);
                }
            }
        }
    }

    /**
     * @param {string} tagName svg tag to search for
     * @return {Array} a list of elements with the given tagname in _svgTag
     */
    _collectElements (tagName) {
        const elts = [];
        const collectElements = domElement => {
            if (domElement.localName === tagName) {
                elts.push(domElement);
            }
            for (let i = 0; i < domElement.childNodes.length; i++) {
                collectElements(domElement.childNodes[i]);
            }
        };
        collectElements(this._svgTag);
        return elts;
    }

    /**
     * Fix SVGs to comply with SVG spec. Scratch 2 defaults to x2 = 0 when x2 is missing, but
     * SVG defaults to x2 = 1 when missing.
     */
    _transformGradients () {
        const linearGradientElements = this._collectElements('linearGradient');

        // For each gradient element, supply x2 if necessary.
        for (const gradientElement of linearGradientElements) {
            if (!gradientElement.getAttribute('x2')) {
                gradientElement.setAttribute('x2', '0');
            }
        }
    }

    /**
     * Fix SVGs to match appearance in Scratch 2, which used nearest neighbor scaling for bitmaps
     * within SVGs.
     */
    _transformImages () {
        const imageElements = this._collectElements('image');

        // For each image element, set image rendering to pixelated"
        const pixelatedImages = 'image-rendering: optimizespeed; image-rendering: pixelated;';
        for (const elt of imageElements) {
            if (elt.getAttribute('style')) {
                elt.setAttribute('style',
                    `${pixelatedImages} ${elt.getAttribute('style')}`);
            } else {
                elt.setAttribute('style', pixelatedImages);
            }
        }
    }

    /**
     * Find the largest stroke width in the svg. If a shape has no
     * `stroke` property, it has a stroke-width of 0. If it has a `stroke`,
     * it is by default a stroke-width of 1.
     * This is used to enlarge the computed bounding box, which doesn't take
     * stroke width into account.
     * @param {SVGSVGElement} rootNode The root SVG node to traverse.
     * @return {number} The largest stroke width in the SVG.
     */
    _findLargestStrokeWidth (rootNode) {
        let largestStrokeWidth = 0;
        const collectStrokeWidths = domElement => {
            if (domElement.getAttribute) {
                if (domElement.getAttribute('stroke')) {
                    largestStrokeWidth = Math.max(largestStrokeWidth, 1);
                }
                if (domElement.getAttribute('stroke-width')) {
                    largestStrokeWidth = Math.max(
                        largestStrokeWidth,
                        Number(domElement.getAttribute('stroke-width')) || 0
                    );
                }
            }
            for (let i = 0; i < domElement.childNodes.length; i++) {
                collectStrokeWidths(domElement.childNodes[i]);
            }
        };
        collectStrokeWidths(rootNode);
        return largestStrokeWidth;
    }

    /**
     * Transform the measurements of the SVG.
     * In Scratch 2.0, SVGs are drawn without respect to the width,
     * height, and viewBox attribute on the tag. The exporter
     * does output these properties - but they appear to be incorrect often.
     * To address the incorrect measurements, we append the DOM to the
     * document, and then use SVG's native `getBBox` to find the real
     * drawn dimensions. This ensures things drawn in negative dimensions,
     * outside the given viewBox, etc., are all eventually drawn to the canvas.
     * I tried to do this several other ways: stripping the width/height/viewBox
     * attributes and then drawing (Firefox won't draw anything),
     * or inflating them and then measuring a canvas. But this seems to be
     * a natural and performant way.
     */
    _transformMeasurements () {
        // Append the SVG dom to the document.
        // This allows us to use `getBBox` on the page,
        // which returns the full bounding-box of all drawn SVG
        // elements, similar to how Scratch 2.0 did measurement.
        const svgSpot = document.createElement('span');
        // Clone the svg tag. This tag becomes unusable/undrawable in browsers
        // once it's appended to the page, perhaps for security reasons?
        const tempTag = this._svgTag.cloneNode(/* deep */ true);
        let bbox;
        try {
            svgSpot.appendChild(tempTag);
            document.body.appendChild(svgSpot);
            // Take the bounding box.
            bbox = tempTag.getBBox();
        } finally {
            // Always destroy the element, even if, for example, getBBox throws.
            document.body.removeChild(svgSpot);
            svgSpot.removeChild(tempTag);
        }

        // Enlarge the bbox from the largest found stroke width
        // This may have false-positives, but at least the bbox will always
        // contain the full graphic including strokes.
        // If the width or height is zero however, don't enlarge since
        // they won't have a stroke width that needs to be enlarged.
        let halfStrokeWidth;
        if (bbox.width === 0 || bbox.height === 0) {
            halfStrokeWidth = 0;
        } else {
            halfStrokeWidth = this._findLargestStrokeWidth(this._svgTag) / 2;
        }
        const width = bbox.width + (halfStrokeWidth * 2);
        const height = bbox.height + (halfStrokeWidth * 2);
        const x = bbox.x - halfStrokeWidth;
        const y = bbox.y - halfStrokeWidth;

        // Set the correct measurements on the SVG tag
        this._svgTag.setAttribute('width', width);
        this._svgTag.setAttribute('height', height);
        this._svgTag.setAttribute('viewBox',
            `${x} ${y} ${width} ${height}`);
    }

    /**
     * Serialize the active SVG DOM to a string.
     * @param {?boolean} shouldInjectFonts True if fonts should be included in the SVG as
     *     base64 data.
     * @returns {string} String representing current SVG data.
     */
    toString (shouldInjectFonts) {
        // return this._svgString;

        const serializer = new XMLSerializer();
        let string = serializer.serializeToString(this._svgDom);
        if (shouldInjectFonts) {
            string = inlineSvgFonts(string);
        }
        return string;
    }

    toJson () {
        if (this._cachedJson) {
            return Promise.resolve({
                paper: this._cachedJson,
                measurements: this._measurements
            });
        }

        return new Promise((resolve, reject) => {
            if (!this._project) {
                if (!_project) {
                    _project = new paper.Project(new paper.Size(100, 100));
                }
                this._project = _project;
            }

            const svgText = this.toString(false /* shouldInjectFonts */);
            const measurements = this._measurements;

            this._project.importSVG(svgText, {
                insert: false,
                onLoad: (item) => {
                    if (!item) {
                        reject(new Error('Could not load svg into paperjs.'));
                        return;
                    }

                    // Give the browser a frame to load embeded raster images.
                    setTimeout(() => {
                        this._cachedJson = item.exportJSON({
                            bounds: 'content',
                            asString: false
                        });

                        const walk = (node, json) => {
                            if (node.className === 'Raster') {
                                if (json[1].source && !json[1].imageData) {
                                    json[1].imageData = node.getImageData();
                                    json[1].pngData = json[1].source.split(/^[^,]*base64,/)[1];
                                    json[1].source = '';
                                    json[1].size = [node.size.width, node.size.height];
                                    // json[1].source = null;
                                }
                                // if (!json[1].source && json[1].imageData) {
                                //     node.setImageData(json[1].imageData);
                                // }

                                return [node];
                                // parent[Object.keys(parent)[index]] = ["Raster", node[1].name];
                            } else if (node.children && json[1].children) {
                                return [].concat(...node.children.map((node, i) => walk(node, json[1].children[i])));
                            }
                            return [];
                        };
                        walk(item, typeof this._cachedJson[0] === 'string' ? this._cachedJson : this._cachedJson[1]);

                        // this._cachedJson = JSON.parse(JSON.stringify({
                        //     paper: this._cachedJson,
                        //     measurements: this._measurements
                        // })).paper;

                        // console.log('loadPaper', {
                        //     paper: this._cachedJson,
                        //     measurements
                        // });

                        resolve({
                            paper: this._cachedJson,
                            measurements
                        });
                    }, 0);
                },
            });
        });
    }

    /**
     * Get the drawing ratio, adjusted for HiDPI screens.
     * @return {number} Scale ratio to draw to canvases with.
     */
    getDrawRatio () {
        const devicePixelRatio = window.devicePixelRatio || 1;
        const backingStoreRatio = this._context.webkitBackingStorePixelRatio ||
            this._context.mozBackingStorePixelRatio ||
            this._context.msBackingStorePixelRatio ||
            this._context.oBackingStorePixelRatio ||
            this._context.backingStorePixelRatio || 1;
        return devicePixelRatio / backingStoreRatio;
    }

    /**
     * Draw the SVG to a canvas. The canvas will automatically be scaled by the value returned by `getDrawRatio`.
     * @param {number} [scale] - Optionally, also scale the image by this factor (multiplied by `getDrawRatio()`).
     * @param {Function} [onFinish] - An optional callback to call when the draw operation is complete.
     */
    _draw (scale, onFinish) {
        // Convert the SVG text to an Image, and then draw it to the canvas.
        if (this._cachedImage) {
            this._drawFromImage(scale, onFinish);
        } else {
            if (!this._project) {
                if (!_project) {
                    _project = new paper.Project(new paper.Size(300, 150));
                }
                this._project = _project;
            }

            const loadImage = () => {
                this._cachedImage = new paper.Group().importJSON(this._cachedJson, {insert: false});
                // this._cachedImage = new paper.Group().importJSON(this._cachedJson, {insert: false});

                // Give the browser a frame to load embedded raster images.
                setTimeout(() => {
                    const walk = (node, json) => {
                        if (node.className === 'Raster') {
                            // if (json[1].source && !json[1].imageData) {
                            //     json[1].imageData = node.getImageData();
                            //     json[1].size = [node.size.width, node.size.height];
                            //     json[1].source = null;
                            // }
                            if (json[1].imageData) {
                                // json[1].source = null;
                                // node.size = new paper.Size(json[1].imageData.width, json[1].imageData.height);
                                node.setImageData(json[1].imageData);
                            }

                            return [node];
                            // parent[Object.keys(parent)[index]] = ["Raster", node[1].name];
                        } else if (node.children && json[1].children) {
                            return [].concat(...node.children.map((node, i) => walk(node, json[1].children[i])));
                        }
                        return [];
                    };
                    walk(this._cachedImage, typeof this._cachedJson[0] === 'string' ? this._cachedJson : this._cachedJson[1]);

                    this._drawFromImage(scale, onFinish);
                }, 0);
            };

            if (this._cachedJson) {
                loadImage();
            } else {
                this.toJson().then(loadImage);
            }
        }
    }

    /**
     * Draw to the canvas from a loaded image element.
     * @param {number} [scale] - Optionally, also scale the image by this factor (multiplied by `getDrawRatio()`).
     * @param {Function} [onFinish] - An optional callback to call when the draw operation is complete.
     **/
    _drawFromImage (scale, onFinish) {
        if (!this._cachedImage) return;

        const ratio = this.getDrawRatio() * (Number.isFinite(scale) ? scale : 1);
        const bbox = this._measurements;
        this._canvas.width = bbox.width * ratio;
        this._canvas.height = bbox.height * ratio;
        // this._project.view.element.width = bbox.width * ratio;
        // this._project.view.element.height = bbox.height * ratio;
        // this._project.addLayer(this._cachedImage.parent);

        // this._project.addLayer(this._cachedImage.parent);
        // this._cachedImage.parent.activate();
        // this._cachedImage.parent.setVisible(true);

        if (!_renderProject) {
            _renderProject = new paper.Project();
        }
        this._renderProject = _renderProject;

        this._renderProject.clear();
        this._renderProject.view.viewSize.set(bbox.width * ratio, bbox.height * ratio);

        this._renderProject.activeLayer.addChild(this._cachedImage);

        this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
        if (bbox.width === 0 || bbox.height === 0) return;
        // this._context.scale(ratio, ratio);
        // this._context.drawImage(this._cachedImage, 0, 0);
        // this._renderProject.view.fitBounds(this._cachedImage.strokeBounds);
        // this._renderProject.view.transform(new paper.Matrix().translate(this._cachedImage.bounds.center).scale(this._cachedImage.bounds.width, this._cachedImage.bounds.height));
        this._renderProject.view.matrix.reset();
        // this._renderProject.view.scale(1 / 10, new paper.Point(0, 0));
        // const ri = new Image();
        // ri.src = this._cachedImage.rasterize().canvas.toDataURL();
        // document.body.appendChild(ri);
        // this._cachedImage.fitBounds(this._renderProject.view.bounds);
        // this._cachedImage.fitBounds(this._cachedImage.strokeBounds);
        // console.log(this._renderProject.view.viewSize, bbox, this._renderProject.view.matrix, this._cachedImage.bounds);
        // this._renderProject.addLayer(this._cachedImage);
        this._renderProject.view.update();
        // debugger;
        this._context.drawImage(this._renderProject.view.element, 0, 0);

        // this._cachedImage.parent.setVisible(false);
        this._cachedImage.remove();

        // const rr = new Image();
        // rr.style.background = 'gray';
        // rr.src = this._canvas.toDataURL();
        // document.body.appendChild(rr);

        // Reset the canvas transform after drawing.
        this._context.setTransform(1, 0, 0, 1, 0, 0);
        // Set the CSS style of the canvas to the actual measurements.
        this._canvas.style.width = bbox.width;
        this._canvas.style.height = bbox.height;

        // const img = new Image();
        // img.src = this._canvas.toDataURL();
        // document.body.appendChild(img);

        // All finished - call the callback if provided.
        if (onFinish) {
            onFinish();
        }
    }
}

module.exports = SvgRenderer;
