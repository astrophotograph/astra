'use client'

import {useEffect, useRef} from "react"

export function MoonImage({illumination, waxing, image = true}: {
  illumination: number,
  waxing: boolean,
  image?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) {
      console.log('illumination: ', illumination, ' waxing: ', waxing, ' image: ', image)
      // @ts-ignore
      drawPlanetPhase(ref.current, illumination, waxing, {
  //       // shadowColor: image ? 'rgba(0,0,0,80)' : 'black',
  //       // lightColor: image ? 'rgba(255, 255, 255, 0)' : 'white',
  //       shadowColour: '#0000008f', // CSS background-colour value for the shaded part of the disc
  //       lightColour: '#ffffff07', // CSS background-colour value for the illuminated part of the disc
  //       shadowColour: '#a0000007', // CSS background-colour value for the shaded part of the disc
  //       lightColour: '#ffffff07', // CSS background-colour value for the illuminated part of the disc
        shadowColour: 'black', // CSS background-colour value for the shaded part of the disc
        lightColour: '#606060', // CSS background-colour value for the illuminated part of the disc
        diameter: 100,    // diameter of the moon/planets disc in pixels
        earthshine: 0,    // between 0 and 1, the amount of light falling on the shaded part of the disc 0=none, 1=full illumination
        blur: 3,       // amount of blur on the terminator in pixels, 0=no blur
      })
    }
  }, [illumination, waxing, image])

  // useEffect(() => {
  //   let v = 0.0
  //   let wax = true
  //   const timer = setInterval(() => {
  //     if (ref.current) {
  //   console.log('drawing illumination: ', v, 'wax', wax)
  //   // @ts-ignore
  //   drawPlanetPhase(ref.current, v, wax)
  //   v = v + 0.05
  //   if (v > 1) {
  //     v = v % 1;
  //     wax = !wax
  //   }
  //     }
  //   }, 1000)
  //
  //   return () => clearInterval(timer)
  // }, [])

  return (
    <div className={'relative h-[100px] min-w-48 grid place-items-center'}>
      {image && <img src={'/ph/img/moon-small.jpg'} className={'h-full object-contain absolute z-30 opacity-30'}/>}
      <div className={'h-[100px] w-[100px] relative'}>
        <div ref={ref}></div>
      </div>
    </div>
  )
}
