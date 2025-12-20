// 'use client'
// https://dev.to/thormeier/use-your-i-moon-gination-lets-build-a-moon-phase-visualizer-with-css-and-js-aih

import {format} from "date-fns"
import {TZDate} from "@date-fns/tz"
import SunCalc from 'suncalc'
import {MoonImage} from "@/components/moon-image"

// const getMoonPhaseRotation = date => {
//   const cycleLength = 29.5 // days
//
//   const knownNewMoon = new Date('2022-03-02 18:34:00')
//   const secondsSinceKnownNewMoon = (date - knownNewMoon) / 1000
//   const daysSinceKnownNewMoon = secondsSinceKnownNewMoon / 60 / 60 / 24
//   const currentMoonPhasePercentage = (daysSinceKnownNewMoon % cycleLength) / cycleLength
//
//   return 360 - Math.floor(currentMoonPhasePercentage * 360)
// }

export function MoonPhase({date}: { date?: Date | TZDate }) {
  if (!date) {
    date = new Date()
  }
  const { phase, fraction } = SunCalc.getMoonIllumination(date)

  /*
  .divider:after {
    content: '';
    background-color: #F4F6F0; // Light
  transform: rotateY(180deg);
}
   */
  return (
    <div className={'flex flex-col space-y-3 border bg-black rounded-lg p-4 items-center'}>
      <MoonImage illumination={fraction} waxing={phase <= 0.5}/>
      {/*<div id={"sphere"} style={{*/}
      {/*  borderRadius: '100%',*/}
      {/*  width: '100px',*/}
      {/*  height: '100px',*/}
      {/*  overflow: 'hidden',*/}
      {/*  display: 'flex',*/}
      {/*  alignItems: 'center',*/}
      {/*  position: 'relative',*/}
      {/*}}>*/}
      {/*  <div id={"light_hemisphere"} style={{*/}
      {/*    width: '50%',*/}
      {/*    height: '100%',*/}
      {/*    backgroundColor: '#F4F6F0',*/}
      {/*  }}>*/}
      {/*  </div>*/}
      {/*  <div id={"dark_hemisphere"} style={{*/}
      {/*    width: '50%',*/}
      {/*    height: '100%',*/}
      {/*    backgroundColor: '#575851',*/}
      {/*  }}></div>*/}
      {/*  <div id={"divider"} style={{*/}
      {/*    top: 0,*/}
      {/*    left: 0,*/}
      {/*    width: '100px',*/}
      {/*    height: '100px',*/}
      {/*    position: 'absolute',*/}
      {/*    borderRadius: '100%',*/}
      {/*    transformStyle: 'preserve-3d',*/}
      {/*    backfaceVisibility: 'hidden',*/}
      {/*    backgroundColor: '#575851',*/}
      {/*  }}></div>*/}
      {/*</div>*/}
      {/*<div className={'text-white'}>Fraction: {(fraction * 100).toFixed(0)}%</div>*/}
      <div className={'text-white'}>Phase: {(fraction * 100).toFixed(0)}%</div>
      <div className={'text-sm'}>Phase of moon on {format(date, 'eee MMM dd yyyy')}</div>
    </div>
  )
}
