# python3 tools/near.py <lon> <lat> <radius_m>: every network segment near a point, with its end nodes, length and routes.
import os
import json, math, sys
n=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "data", "network.json"))); R=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "data", "routes.json"))); R=R["routes"] if isinstance(R,dict) and "routes" in R else R
by={r["id"]:r for r in R}; L=n["lines"]; E=n["edges"]
lab=lambda i: by[L[i]]["label"] if L[i] in by else L[i]
LAT0=47.61; KX=111320*math.cos(math.radians(LAT0)); KY=110574
m=lambda c:((c[0]+122.33)*KX,(c[1]-LAT0)*KY)
cx,cy=m((float(sys.argv[1]),float(sys.argv[2]))); rad=float(sys.argv[3])
def ln(e):
    p=[m(c) for c in e["c"]]; return sum(math.hypot(p[i+1][0]-p[i][0],p[i+1][1]-p[i][1]) for i in range(len(p)-1))
nodes={}
def nid(c):
    k=(round(c[0],6),round(c[1],6))
    if k not in nodes: nodes[k]=len(nodes)
    return nodes[k]
for k,e in enumerate(E):
    a,b=m(e["c"][0]),m(e["c"][-1])
    if min(math.hypot(a[0]-cx,a[1]-cy),math.hypot(b[0]-cx,b[1]-cy))<rad:
        print(k, "N%d->N%d"%(nid(e["c"][0]),nid(e["c"][-1])), "a=(%.0f,%.0f) b=(%.0f,%.0f)"%(a[0]-cx,a[1]-cy,b[0]-cx,b[1]-cy), "len",round(ln(e)), [lab(i) for i in e["l"]][:9], "+%d"%max(0,len(e["l"])-9))
