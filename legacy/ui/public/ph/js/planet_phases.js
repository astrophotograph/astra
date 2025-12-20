// From https://codebox.net/pages/html-moon-planet-phases
// note: there seem to be bugs around 100% and 50%
/*
    Defines the function 'drawPlanetPhase' which will render a 'kind of' realistic lunar or planetary disc with
    shadow.

    The simplest way to call the function is like this:

        drawPlanetPhase(document.getElementById('container'), 0.15, true)

    the first argument is the HTML element that you want to contain the disc

    the second argument must be a value between 0 and 1, indicating how large the shadow should be:
           0 = new moon
        0.25 = crescent
        0.50 = quarter
        0.75 = gibbous
        1.00 = full moon

    the third argument is a boolean value indicating whether the disc should be waxing or waning (ie which
    side of the disc the shadow should be on):
         true = waxing - shadow on the left
        false = waning - shadow on the right

    the function accepts an optional fourth argument, containing configuration values which change the
    size, colour and appearance of the disc - see the comments on the 'defaultConfig' object for details.

    Copyright 2014 Rob Dawson
    http://codebox.org.uk/pages/planet-phase
*/

var drawPlanetPhase = (function(){
  "use strict";
  /*jslint browser: true, forin: true, white: true */

  function calcInner(outerDiameter, semiPhase){
    var innerRadius,
      absPhase = Math.abs(semiPhase),
      n = ((1-absPhase) * outerDiameter/2) || 0.01;

    innerRadius = n/2 + outerDiameter * outerDiameter/ (8 * n);

    return {
      d : innerRadius * 2,
      o : semiPhase > 0 ? (outerDiameter/2 - n) : (-2 * innerRadius + outerDiameter/2 + n)
    };
  }

  function setCss(el, props){
    console.log('setCss', props)
    var p;
    for (p in props){
      el.style[p] = props[p];
    }
  }

  function drawDiscs(outer, inner, blurSize){
    var blurredDiameter, blurredOffset;
    // Draw outer box
    setCss(outer.box, {
      'position': 'absolute',
      'height':    outer.diameter + 'px',
      'width':     outer.diameter + 'px',
      'border':   '1px solid black',
      'backgroundColor': outer.colour,
      'borderRadius': (outer.diameter/2) + 'px',
      'overflow': 'hidden',
      'zIndex' : outer.innerTop ? 10 : 20
    });

    blurredDiameter = inner.diameter - blurSize;
    blurredOffset = inner.offset + blurSize/2;

    // Draw inner box
    setCss(inner.box, {
      'position': 'absolute',
      'backgroundColor': inner.colour,
      'borderRadius': (blurredDiameter/2) + 'px',
      // 'border': '2px solid green',
      'height': blurredDiameter + 'px',
      'width': blurredDiameter + 'px',
      'left': blurredOffset + 'px',
      'top': ((outer.diameter-blurredDiameter)/2) + 'px',
      'boxShadow': '0px 0px ' + blurSize + 'px ' + blurSize + 'px ' + inner.colour,
      // 'opacity' : inner.opacity,
      'zIndex' : inner.innerTop ? 20 : 10
    });
  }
  function makeDiv(container){
    var div = document.createElement('div');
    // setCss(div, {
    //   backgroundImage: 'url(/img/moon-small.jpg)',
    //   backgroundSize: '500px',
    //   backgroundPosition: 'right',
    // })
    container.appendChild(div);
    return div;
  }
  function setPhase(outerBox, phase, isWaxing, config){
    var innerBox = makeDiv(outerBox),
      outerColour,
      innerColour,
      innerVals,
      innerTop;

    if (phase < 0.5){
      outerColour = config.lightColour;
      innerColour = config.shadowColour;
      innerTop = true;
      if (isWaxing){
        phase *= -1;
      }
    } else {
      outerColour = config.shadowColour;
      innerColour = config.lightColour;
      innerTop = false;
      phase = 1 - phase;
      if (!isWaxing){
        phase *= -1;
      }
    }

    innerVals = calcInner(config.diameter, phase * 2);

    drawDiscs({
      box : outerBox,
      diameter : config.diameter,
      colour: outerColour,
      innerTop: innerTop
    }, {
      box : innerBox,
      diameter : innerVals.d,
      colour: innerColour,
      offset: innerVals.o,
      opacity : 1 - config.earthshine,
      innerTop: innerTop
    }, config.blur);
  }

  var defaultConfig = {
    shadowColour: 'black', // CSS background-colour value for the shaded part of the disc
    lightColour:  'white', // CSS background-colour value for the illuminated part of the disc
    diameter:      100,    // diameter of the moon/planets disc in pixels
    earthshine :   0.1,    // between 0 and 1, the amount of light falling on the shaded part of the disc 0=none, 1=full illumination
    blur:          3       // amount of blur on the terminator in pixels, 0=no blur
  };

  function populateMissingConfigValues(config){
    var p;
    for(p in defaultConfig) {
      config[p] = (config[p] === undefined) ? defaultConfig[p] : config[p];
    }
    return config;
  }

  return function(containerEl, phase, isWaxing, config){
    if (phase >= 0.49 && phase <= 0.51){
      // We nudge number if it's around 0.5 due to some bug I don't have the time to look into...
      phase = 0.49;
    }
    config = populateMissingConfigValues(Object.create(config || {}));
    var el = makeDiv(containerEl);
    setPhase(el, phase, isWaxing, config);
  };

}());
