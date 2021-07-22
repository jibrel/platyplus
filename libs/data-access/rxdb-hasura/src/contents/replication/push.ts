import { clone, RxGraphQLReplicationQueryBuilder } from 'rxdb'
import { jsonToGraphQLQuery, EnumType } from 'json-to-graphql-query'

import { Contents, ContentsCollection, Modifier } from '../../types'
import { computedFields } from '../computed-fields'
import {
  filteredRelationships,
  getIds,
  isManyToManyTable,
  metadataName
} from '../schema'
import { reduceStringArrayValues } from '@platyplus/data'
import { debug } from '../../console'

// * Not ideal as it means 'updated_at' column should NEVER be created in the frontend
const isNewDocument = (doc: Contents): boolean => !doc.updated_at

export const pushQueryBuilder = (
  collection: ContentsCollection
): RxGraphQLReplicationQueryBuilder => {
  const table = collection.metadata
  const title = metadataName(table)
  const idKeys = getIds(table)

  const arrayRelationships = filteredRelationships(table).filter(
    (rel) => rel.rel_type === 'array'
  )

  return ({ _isNew, ...initialDoc }: Contents) => {
    debug('push query builder in', initialDoc)
    const doc = clone(initialDoc)

    Object.keys(doc)
      .filter((key) => key.startsWith('_'))
      .forEach((key) => delete doc[key])

    const arrayValues: Record<string, string[]> = {}
    for (const { rel_name } of arrayRelationships) {
      arrayValues[rel_name] = doc[rel_name]
      delete doc[rel_name]
      delete doc[`${rel_name}_aggregate`]
    }

    const { id, ...updateDoc } = doc
    const query = jsonToGraphQLQuery({
      mutation: {
        ...(_isNew
          ? {
              [`insert_${title}_one`]: {
                __args: { object: doc },
                ...reduceStringArrayValues(idKeys, () => true)
              }
            }
          : {
              [`update_${title}`]: {
                __args: {
                  where: {
                    id: {
                      _eq: id
                    }
                  },
                  _set: updateDoc
                },
                returning: reduceStringArrayValues(idKeys, () => true)
              }
            }),
        ...arrayRelationships.reduce((acc, rel) => {
          // TODO relations with composite ids
          const isManyToMany = isManyToManyTable(rel.remoteTable)
          const mapping = rel.mapping[0]
          const joinTable = metadataName(rel.remoteTable)
          const reverseId = rel.remoteTable.primaryKey.columns.find(
            (col) => col.columnName !== mapping.remoteColumnName
          ).columnName
          if (isManyToMany) {
            acc[`update_${joinTable}`] = {
              __args: {
                where: {
                  [mapping.remoteColumnName]: {
                    _eq: doc.id
                  }
                },
                _set: { deleted: true }
              },
              affected_rows: true
            }
          }

          if (arrayValues[rel.rel_name]?.length) {
            if (isManyToMany) {
              acc[`insert_${joinTable}`] = {
                __args: {
                  objects: arrayValues[rel.rel_name].map((id: string) => ({
                    [reverseId]: id,
                    [mapping.remoteColumnName]: doc.id,
                    deleted: false
                  })),
                  on_conflict: {
                    constraint: new EnumType(
                      rel.remoteTable.primaryKey.constraint_name
                    ),
                    update_columns: [new EnumType('deleted')],
                    where: { deleted: { _eq: true } }
                  }
                },
                affected_rows: true
              }
            } else {
              acc[`insert_${joinTable}`] = {
                __args: {
                  objects: arrayValues[rel.rel_name].map((id: string) => ({
                    [reverseId]: id,
                    [mapping.remoteColumnName]: doc.id
                  })),
                  on_conflict: {
                    constraint: new EnumType(
                      rel.remoteTable.primaryKey.constraint_name
                    ),
                    update_columns: [new EnumType(mapping.remoteColumnName)]
                  }
                },
                affected_rows: true
              }
            }
          }
          return acc
        }, {})
      }
    })
    debug('push query builder:', { query })
    return {
      query,
      variables: {}
    }
  }
}

export const pushModifier = (collection: ContentsCollection): Modifier => {
  // TODO replicate only what has changed e.g. _changes sent to the query builder
  const table = collection.metadata
  // * Don't push changes on views
  if (table.view) return () => null

  const relationships = filteredRelationships(table)
  const objectRelationships = relationships.filter(
    ({ rel_type }) => rel_type === 'object'
  )

  return async (data) => {
    debug('pushModifier: in:', data)
    // * Do not push data if it is flaged as a local change
    if (data.is_local_change) return null
    else delete data.is_local_change

    const _isNew = isNewDocument(data)
    const id = data.id // * Keep the id to avoid removing it as it is supposed to be part of the columns to exclude from updates

    // * Object relationships:move back property name to the right foreign key column
    for (const { rel_name, mapping } of objectRelationships) {
      if (data[rel_name] !== undefined) {
        data[mapping[0].column?.name] = data[rel_name]
        delete data[rel_name]
      }
    }

    // * Exclude 'always' excludable fields e.g. array many2one relationships and not permitted columns
    const excluded = computedFields(collection)
    if (collection.role === 'admin') {
      excluded.push(
        ...table.columns
          .filter(
            (column) => !column[_isNew ? 'canInsert' : 'canUpdate'].length
          )
          .map((column) => column.name)
      )
    }
    for (const field of excluded) delete data[field]

    debug('pushModifier: out', { _isNew, ...data, id })
    return { _isNew, ...data, id }
  }
}
