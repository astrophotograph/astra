import {fetchCollectionStats} from "@/lib/db"

export async function CollectionStats({collection_id}: { collection_id: string }) {
  const stats = await fetchCollectionStats(collection_id)

  if (!stats) {
    return null
  }

  return null;
  // return (
  //   <table
  //     className="table-auto border-collapse my-6 border outline outline-1 outline-gray-400 overflow-hidden text-center rounded-lg">
  //     <tbody>
  //     {stats.total_integration_time && (
  //       <tr>
  //         <td className="bg-slate-800 border border-gray-500 p-2 text-slate-300">Total Integration Time</td>
  //         <td className="bg-slate-900 border border-gray-500 p-2 ">{stats.total_integration_time}</td>
  //       </tr>)}
  //     {stats.images && (
  //       <tr>
  //         <td className="bg-slate-800 border border-gray-500 p-2 text-slate-300">Imaged Objects</td>
  //         <td className="bg-slate-900 border border-gray-500 p-2">{stats.images}</td>
  //       </tr>
  //     )}
  //     <tr>
  //       <td className="bg-slate-800 border border-gray-500 p-2 text-slate-300">Total objects</td>
  //       <td className="bg-slate-900 border border-gray-500 p-2">{stats.total}</td>
  //     </tr>
  //     </tbody>
  //   </table>
  // )
}
